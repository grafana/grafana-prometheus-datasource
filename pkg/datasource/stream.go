package datasource

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

// searchChannelPrefix is the only channel namespace the search stream handler serves.
// Channels look like "search/<sessionNonce>" — one persistent channel per browser
// session/datasource-client so frames never leak between org-mates.
const searchChannelPrefix = "search/"

// mailboxBuffer is the buffered capacity of each per-channel mailbox. A small buffer
// absorbs the startup race (a publish arriving before RunStream's select loop is ready)
// without unbounded growth; under fast typing PublishStream applies latest-wins drop.
const mailboxBuffer = 8

// maxConcurrentSlots bounds how many independent search "slots" (endpoint + widget
// slotId) run upstream requests concurrently on one channel. Independent widgets and
// panels sharing a datasource instance must not cancel each other, but we still cap
// fan-out. cancel-previous is scoped per slot, not globally.
const maxConcurrentSlots = 8

// searchRequestTimeout bounds a single upstream NDJSON read.
const searchRequestTimeout = 30 * time.Second

// publishMsg is the in-process message carried over a mailbox from PublishStream to
// RunStream.
type publishMsg struct {
	requestID string
	slotID    string
	endpoint  string
	params    url.Values
}

// publishPayload is the wire shape published by the frontend SearchApiClient over the
// Live channel. params is a map of repeated query params (e.g. {"search[]": ["up"]}).
type publishPayload struct {
	RequestID string              `json:"requestId"`
	SlotID    string              `json:"slotId"`
	Endpoint  string              `json:"endpoint"`
	Params    map[string][]string `json:"params"`
}

// responseEnvelope is the wire shape sent back to the frontend for every line, tagged
// with the originating requestId (and slotId) so the client can correlate and discard
// stale frames.
type responseEnvelope struct {
	RequestID string            `json:"requestId"`
	SlotID    string            `json:"slotId"`
	Type      string            `json:"type"` // "batch" | "terminal" | "error"
	Results   []json.RawMessage `json:"results,omitempty"`
	Warnings  []string          `json:"warnings,omitempty"`
	HasMore   bool              `json:"hasMore,omitempty"`
	Error     string            `json:"error,omitempty"`
	ErrorType string            `json:"errorType,omitempty"`
}

// --- mailbox registry -------------------------------------------------------

// createMailbox returns the buffered mailbox for path, creating it if necessary. It is
// idempotent so reconnects (Subscribe again) reuse the existing channel.
func (d *Datasource) createMailbox(path string) chan publishMsg {
	d.mailboxesMu.Lock()
	defer d.mailboxesMu.Unlock()
	if mb, ok := d.mailboxes[path]; ok {
		return mb
	}
	mb := make(chan publishMsg, mailboxBuffer)
	d.mailboxes[path] = mb
	return mb
}

// getMailbox returns the mailbox for path if it exists.
func (d *Datasource) getMailbox(path string) (chan publishMsg, bool) {
	d.mailboxesMu.Lock()
	defer d.mailboxesMu.Unlock()
	mb, ok := d.mailboxes[path]
	return mb, ok
}

// removeMailbox drops the mailbox for path. Called on RunStream stop.
func (d *Datasource) removeMailbox(path string) {
	d.mailboxesMu.Lock()
	defer d.mailboxesMu.Unlock()
	delete(d.mailboxes, path)
}

// --- backend.StreamHandler --------------------------------------------------

// SubscribeStream authorizes a subscription to a search channel. Core has already
// validated org membership and datasource read permission before this is called, so we
// only enforce the channel/endpoint allowlist (no arbitrary upstream paths -> no SSRF)
// and create the buffered mailbox before the first publish can arrive.
func (d *Datasource) SubscribeStream(_ context.Context, req *backend.SubscribeStreamRequest) (*backend.SubscribeStreamResponse, error) {
	if !strings.HasPrefix(req.Path, searchChannelPrefix) {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	d.createMailbox(req.Path)
	return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusOK}, nil
}

// PublishStream validates a client->server publish and pushes it to the channel's
// mailbox. Core applies no admin gate on this path, so the endpoint allowlist and
// payload validation are our responsibility. Sends are non-blocking with latest-wins
// drop: if the buffer is full the oldest pending request is discarded in favor of the
// newest, matching the "supersede stale params" intent.
func (d *Datasource) PublishStream(_ context.Context, req *backend.PublishStreamRequest) (*backend.PublishStreamResponse, error) {
	if !strings.HasPrefix(req.Path, searchChannelPrefix) {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}

	var payload publishPayload
	if err := json.Unmarshal(req.Data, &payload); err != nil {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}
	if !resource.IsValidSearchEndpoint(payload.Endpoint) || payload.RequestID == "" {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}

	mb, ok := d.getMailbox(req.Path)
	if !ok {
		// No active subscription/mailbox for this channel.
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusNotFound}, nil
	}

	msg := publishMsg{
		requestID: payload.RequestID,
		slotID:    payload.SlotID,
		endpoint:  payload.Endpoint,
		params:    url.Values(payload.Params),
	}

	enqueue(mb, msg)
	return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusOK}, nil
}

// enqueue pushes msg without blocking. If the mailbox is full it drops one buffered
// message to make room (latest-wins), so a burst of keystrokes can never block the
// publish path.
func enqueue(mb chan publishMsg, msg publishMsg) {
	select {
	case mb <- msg:
		return
	default:
	}
	// Full: drop one and retry once.
	select {
	case <-mb:
	default:
	}
	select {
	case mb <- msg:
	default:
	}
}

// RunStream is the long-lived per-channel loop. It idles on the mailbox; for each
// published request it cancels any previous in-flight request for the SAME slot
// (endpoint + slotId), then runs the upstream NDJSON read in a bounded goroutine,
// forwarding requestId-tagged frames. Independent slots run concurrently.
func (d *Datasource) RunStream(ctx context.Context, req *backend.RunStreamRequest, sender *backend.StreamSender) error {
	mb := d.createMailbox(req.Path)
	defer d.removeMailbox(req.Path)

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrentSlots)
	// slotCancels tracks the in-flight cancel func per slot. Only the RunStream loop
	// reads/writes it, so no extra locking is needed.
	slotCancels := make(map[string]context.CancelFunc)

	defer func() {
		for _, cancel := range slotCancels {
			cancel()
		}
		wg.Wait()
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-mb:
			slotKey := msg.endpoint + "|" + msg.slotID
			if cancel, ok := slotCancels[slotKey]; ok {
				// cancel-previous, scoped to this slot only.
				cancel()
			}

			reqCtx, cancel := context.WithTimeout(ctx, searchRequestTimeout)
			slotCancels[slotKey] = cancel

			wg.Add(1)
			sem <- struct{}{}
			go func(m publishMsg, rctx context.Context, cancel context.CancelFunc) {
				defer wg.Done()
				defer func() { <-sem }()
				defer cancel()
				d.runSearch(rctx, req.PluginContext, m, sender)
			}(msg, reqCtx, cancel)
		}
	}
}

// runSearch executes a single upstream search read and forwards frames. It guarantees a
// single terminal frame per requestId: if the upstream omitted a trailer (abrupt EOF) a
// synthetic terminal frame is sent so the frontend promise/observable always settles.
// A cancelled request (superseded by a newer one for the same slot) sends nothing.
func (d *Datasource) runSearch(ctx context.Context, pCtx backend.PluginContext, m publishMsg, sender *backend.StreamSender) {
	sawTerminal := false

	err := d.Service.StreamSearch(ctx, pCtx, m.endpoint, m.params, func(line resource.SearchLine) error {
		env := envelopeFromLine(m, line)
		if env.Type == "terminal" || env.Type == "error" {
			sawTerminal = true
		}
		return sendEnvelope(sender, env)
	})

	if err != nil {
		if errors.Is(err, context.Canceled) {
			// Superseded by a newer request on the same slot; stay silent.
			return
		}
		if errors.Is(err, context.DeadlineExceeded) {
			_ = sendEnvelope(sender, responseEnvelope{
				RequestID: m.requestID, SlotID: m.slotID, Type: "error", Error: "search request timed out",
			})
			return
		}
		if d.logger != nil {
			d.logger.Warn("search stream read failed", "endpoint", m.endpoint, "error", err)
		}
		_ = sendEnvelope(sender, responseEnvelope{
			RequestID: m.requestID, SlotID: m.slotID, Type: "error", Error: err.Error(),
		})
		return
	}

	if !sawTerminal {
		// Abrupt EOF without a trailer: treat collected results as complete.
		_ = sendEnvelope(sender, responseEnvelope{RequestID: m.requestID, SlotID: m.slotID, Type: "terminal"})
	}
}

// envelopeFromLine maps a decoded upstream line to a wire envelope tagged with the
// originating request/slot ids.
func envelopeFromLine(m publishMsg, line resource.SearchLine) responseEnvelope {
	env := responseEnvelope{RequestID: m.requestID, SlotID: m.slotID, Warnings: line.Warnings}
	switch {
	case line.IsError():
		env.Type = "error"
		env.Error = line.Error
		env.ErrorType = line.ErrType
	case line.IsTerminal():
		env.Type = "terminal"
		env.HasMore = line.HasMore
	default:
		env.Type = "batch"
		env.Results = line.Results
	}
	return env
}

func sendEnvelope(sender *backend.StreamSender, env responseEnvelope) error {
	b, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return sender.SendJSON(b)
}
