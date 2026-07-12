package promlib

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

// searchChannelPattern is the only channel shape the search stream handler serves.
// Channels look like "search/<sessionNonce>" — one persistent channel per browser
// session/datasource-client so frames never leak between org-mates.
var searchChannelPattern = regexp.MustCompile(`^search/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// mailboxBuffer bounds distinct slots pending in each channel. A small buffer absorbs
// the startup race without unbounded growth; repeated work for one slot is coalesced.
const mailboxBuffer = 8

// streamOutputBuffer bounds responses waiting for the single StreamSender writer.
const streamOutputBuffer = 32

// mailboxCancellationBuffer bounds cancellation responses retained while pending work
// is coalesced before RunStream consumes it.
const mailboxCancellationBuffer = 32

// maxConcurrentSlots bounds how many independent search "slots" (endpoint + widget
// slotId) run upstream requests concurrently on one channel. Independent widgets and
// panels sharing a datasource instance must not cancel each other, but we still cap
// fan-out. cancel-previous is scoped per slot, not globally.
const maxConcurrentSlots = 8

// searchRequestTimeout bounds a single upstream NDJSON read.
const searchRequestTimeout = 30 * time.Second

const (
	maxIdentifierLength   = 128
	maxParamValues        = 20
	maxSearchTerms        = 5
	maxParamValueLength   = 4096
	maxSearchTermLength   = 256
	maxSearchLimit        = 10000
	maxSearchBatchSize    = 1000
	maxSearchTimeRange    = 90 * 24 * time.Hour
	maxActiveChannels     = 32
	maxConcurrentSearches = 16
)

var searchIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)

var errSearchSuperseded = errors.New("search request superseded")

var allowedSearchParams = map[string]struct{}{
	"start": {}, "end": {}, "case_sensitive": {}, "batch_size": {}, "limit": {},
	"search[]": {}, "sort_by": {}, "fuzz_alg": {}, "fuzz_threshold": {},
	"match[]": {}, "label": {},
}

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

type searchMailbox struct {
	mu       sync.Mutex
	owner    requesterIdentity
	pending  map[string]publishMsg
	order    []string
	canceled []publishMsg
	wake     chan struct{}
}

type requesterIdentity struct {
	login string
	email string
	name  string
	role  string
}

func requesterIdentityFromPluginContext(pluginContext backend.PluginContext) (requesterIdentity, bool) {
	if pluginContext.User == nil {
		return requesterIdentity{}, false
	}
	identity := requesterIdentity{
		login: strings.TrimSpace(pluginContext.User.Login),
		email: strings.TrimSpace(pluginContext.User.Email),
		name:  strings.TrimSpace(pluginContext.User.Name),
		role:  strings.TrimSpace(pluginContext.User.Role),
	}
	return identity, identity != (requesterIdentity{})
}

func newSearchMailbox(owner requesterIdentity) *searchMailbox {
	return &searchMailbox{
		pending:  make(map[string]publishMsg),
		order:    make([]string, 0, mailboxBuffer),
		canceled: make([]publishMsg, 0, mailboxCancellationBuffer),
		wake:     make(chan struct{}, 1),
		owner:    owner,
	}
}

func publishSlotKey(msg publishMsg) string {
	return msg.endpoint + "|" + msg.slotID
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
func (s *Service) createMailbox(path string, owner requesterIdentity) *searchMailbox {
	s.mailboxesMu.Lock()
	defer s.mailboxesMu.Unlock()
	if mb, ok := s.mailboxes[path]; ok {
		if mb.owner != owner {
			return nil
		}
		return mb
	}
	if len(s.mailboxes) >= maxActiveChannels {
		return nil
	}
	mb := newSearchMailbox(owner)
	s.mailboxes[path] = mb
	return mb
}

// getMailbox returns the mailbox for path if it exists.
func (s *Service) getMailbox(path string) (*searchMailbox, bool) {
	s.mailboxesMu.Lock()
	defer s.mailboxesMu.Unlock()
	mb, ok := s.mailboxes[path]
	return mb, ok
}

// removeMailbox drops the mailbox for path. Called on RunStream stop.
func (s *Service) removeMailbox(path string) {
	s.mailboxesMu.Lock()
	defer s.mailboxesMu.Unlock()
	delete(s.mailboxes, path)
}

// --- backend.StreamHandler --------------------------------------------------

// SubscribeStream authorizes a subscription to a search channel. Core has already
// validated org membership and datasource read permission before this is called, so we
// only enforce the channel/endpoint allowlist (no arbitrary upstream paths -> no SSRF)
// and create the buffered mailbox before the first publish can arrive.
func (s *Service) SubscribeStream(_ context.Context, req *backend.SubscribeStreamRequest) (*backend.SubscribeStreamResponse, error) {
	if !searchAPIEnabled(req.PluginContext) {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	if !searchChannelPattern.MatchString(req.Path) {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	owner, ok := requesterIdentityFromPluginContext(req.PluginContext)
	if !ok || s.createMailbox(req.Path, owner) == nil {
		return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusNotFound}, nil
	}
	return &backend.SubscribeStreamResponse{Status: backend.SubscribeStreamStatusOK}, nil
}

// PublishStream validates a client->server publish and pushes it to the channel's
// mailbox. Core applies no admin gate on this path, so the endpoint allowlist and
// payload validation are our responsibility. Sends are non-blocking and pending work is
// coalesced only within the same slot, so one hot widget cannot evict another.
func (s *Service) PublishStream(_ context.Context, req *backend.PublishStreamRequest) (*backend.PublishStreamResponse, error) {
	if !searchAPIEnabled(req.PluginContext) {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}
	if !searchChannelPattern.MatchString(req.Path) {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}

	var payload publishPayload
	if err := json.Unmarshal(req.Data, &payload); err != nil {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}
	if !resource.IsValidSearchEndpoint(payload.Endpoint) || !validatePublishPayload(&payload) {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}

	mb, ok := s.getMailbox(req.Path)
	if !ok {
		// No active subscription/mailbox for this channel.
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusNotFound}, nil
	}
	owner, ok := requesterIdentityFromPluginContext(req.PluginContext)
	if !ok || mb.owner != owner {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}

	msg := publishMsg{
		requestID: payload.RequestID,
		slotID:    payload.SlotID,
		endpoint:  payload.Endpoint,
		params:    url.Values(payload.Params),
	}

	if !enqueue(mb, msg) {
		return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusPermissionDenied}, nil
	}
	return &backend.PublishStreamResponse{Status: backend.PublishStreamStatusOK}, nil
}

func validatePublishPayload(payload *publishPayload) bool {
	if !validSearchIdentifier(payload.RequestID) || !validSearchIdentifier(payload.SlotID) {
		return false
	}
	for name, values := range payload.Params {
		if _, ok := allowedSearchParams[name]; !ok || len(values) == 0 || len(values) > maxParamValues {
			return false
		}
		if name != "search[]" && name != "match[]" && len(values) != 1 {
			return false
		}
		if name == "search[]" && len(values) > maxSearchTerms {
			return false
		}
		for _, value := range values {
			maxLength := maxParamValueLength
			if name == "search[]" {
				maxLength = maxSearchTermLength
			}
			if len(value) == 0 || len(value) > maxLength {
				return false
			}
		}
	}
	if !validateEnumParam(payload.Params, "case_sensitive", "true", "false") ||
		!validateEnumParam(payload.Params, "sort_by", "alpha", "score") ||
		!validateEnumParam(payload.Params, "fuzz_alg", "subsequence") {
		return false
	}
	if !clampPositiveInt(payload.Params, "limit", maxSearchLimit, true) ||
		!clampPositiveInt(payload.Params, "batch_size", maxSearchBatchSize, false) ||
		!clampIntRange(payload.Params, "fuzz_threshold", 0, 100) {
		return false
	}
	return clampTimeRange(payload.Params)
}

func validSearchIdentifier(value string) bool {
	return value != "" && len(value) <= maxIdentifierLength && searchIdentifierPattern.MatchString(value)
}

func validateEnumParam(params map[string][]string, name string, allowed ...string) bool {
	values, ok := params[name]
	if !ok {
		return true
	}
	for _, candidate := range allowed {
		if values[0] == candidate {
			return true
		}
	}
	return false
}

func clampPositiveInt(params map[string][]string, name string, maximum int, rejectZero bool) bool {
	values, ok := params[name]
	if !ok {
		return true
	}
	value, err := strconv.Atoi(values[0])
	if err != nil || value < 0 || (rejectZero && value == 0) || (!rejectZero && value < 1) {
		return false
	}
	if value > maximum {
		params[name] = []string{strconv.Itoa(maximum)}
	}
	return true
}

func clampIntRange(params map[string][]string, name string, minimum, maximum int) bool {
	values, ok := params[name]
	if !ok {
		return true
	}
	value, err := strconv.Atoi(values[0])
	if err != nil || value < minimum {
		return false
	}
	if value > maximum {
		params[name] = []string{strconv.Itoa(maximum)}
	}
	return true
}

func clampTimeRange(params map[string][]string) bool {
	startValues, hasStart := params["start"]
	endValues, hasEnd := params["end"]
	if !hasStart && !hasEnd {
		return true
	}
	var start, end float64
	var ok bool
	if hasStart {
		if start, ok = parseSearchTimestamp(startValues[0]); !ok {
			return false
		}
	}
	if hasEnd {
		if end, ok = parseSearchTimestamp(endValues[0]); !ok {
			return false
		}
	}
	if hasStart && hasEnd {
		if end < start {
			return false
		}
		maxSeconds := maxSearchTimeRange.Seconds()
		if end-start > maxSeconds {
			params["start"] = []string{strconv.FormatFloat(end-maxSeconds, 'f', -1, 64)}
		}
	}
	return true
}

func parseSearchTimestamp(value string) (float64, bool) {
	if timestamp, err := strconv.ParseFloat(value, 64); err == nil {
		return timestamp, !math.IsNaN(timestamp) && !math.IsInf(timestamp, 0)
	}
	timestamp, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return float64(timestamp.UnixNano()) / float64(time.Second), true
}

// enqueue keeps at most one pending request per slot. A hot slot replaces only its own
// pending work and can never evict an unrelated slot.
func enqueue(mb *searchMailbox, msg publishMsg) bool {
	key := publishSlotKey(msg)
	mb.mu.Lock()
	if previous, exists := mb.pending[key]; exists {
		if len(mb.canceled) >= mailboxCancellationBuffer {
			mb.mu.Unlock()
			return false
		}
		mb.canceled = append(mb.canceled, previous)
	} else {
		if len(mb.pending) >= mailboxBuffer {
			mb.mu.Unlock()
			return false
		}
		mb.order = append(mb.order, key)
	}
	mb.pending[key] = msg
	mb.mu.Unlock()

	select {
	case mb.wake <- struct{}{}:
	default:
	}
	return true
}

func (mb *searchMailbox) next() (publishMsg, bool, bool) {
	mb.mu.Lock()
	defer mb.mu.Unlock()
	if len(mb.canceled) > 0 {
		msg := mb.canceled[0]
		mb.canceled = mb.canceled[1:]
		mb.signalIfPending()
		return msg, true, true
	}
	if len(mb.order) == 0 {
		return publishMsg{}, false, false
	}
	key := mb.order[0]
	mb.order = mb.order[1:]
	msg := mb.pending[key]
	delete(mb.pending, key)
	mb.signalIfPending()
	return msg, false, true
}

func (mb *searchMailbox) signalIfPending() {
	if len(mb.canceled) > 0 || len(mb.order) > 0 {
		select {
		case mb.wake <- struct{}{}:
		default:
		}
	}
}

// RunStream is the long-lived per-channel loop. It idles on the mailbox; for each
// published request it cancels any previous in-flight request for the SAME slot
// (endpoint + slotId), then runs the upstream NDJSON read in a bounded goroutine,
// forwarding requestId-tagged frames. Independent slots run concurrently.
func (s *Service) RunStream(ctx context.Context, req *backend.RunStreamRequest, sender *backend.StreamSender) error {
	if !searchAPIEnabled(req.PluginContext) {
		return errors.New("search API streaming is disabled for this datasource")
	}
	if !searchChannelPattern.MatchString(req.Path) {
		return errors.New("invalid search stream channel path")
	}
	owner, ok := requesterIdentityFromPluginContext(req.PluginContext)
	if !ok {
		return errors.New("search stream requester identity is unavailable")
	}
	runCtx, cancelRun, releaseRun, err := s.registerRun(ctx)
	if err != nil {
		return err
	}
	defer releaseRun()

	mb := s.createMailbox(req.Path, owner)
	if mb == nil {
		return errors.New("search stream channel budget exceeded")
	}
	defer s.removeMailbox(req.Path)

	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConcurrentSlots)
	output := make(chan responseEnvelope, streamOutputBuffer)
	writerErr := make(chan error, 1)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		if err := writeEnvelopes(runCtx, sender, output); err != nil {
			writerErr <- err
			cancelRun()
		}
	}()

	// slotCancels tracks the in-flight cancel func per slot. Only the RunStream loop
	// reads/writes it, so no extra locking is needed.
	slotCancels := make(map[string]context.CancelCauseFunc)

	defer func() {
		cancelRun()
		for _, cancel := range slotCancels {
			cancel(context.Canceled)
		}
		wg.Wait()
		close(output)
		<-writerDone
	}()

	for {
		select {
		case err := <-writerErr:
			return err
		case <-runCtx.Done():
			select {
			case err := <-writerErr:
				return err
			default:
				return runCtx.Err()
			}
		case <-mb.wake:
			msg, canceled, ok := mb.next()
			if !ok {
				continue
			}
			if canceled {
				select {
				case output <- canceledEnvelope(msg):
					continue
				case <-runCtx.Done():
					return runCtx.Err()
				}
			}
			slotKey := publishSlotKey(msg)
			if cancel, ok := slotCancels[slotKey]; ok {
				// cancel-previous, scoped to this slot only.
				cancel(errSearchSuperseded)
			}

			reqCtx, cancel := context.WithCancelCause(runCtx)
			slotCancels[slotKey] = cancel

			wg.Add(1)
			go func(m publishMsg, rctx context.Context, cancel context.CancelCauseFunc) {
				defer wg.Done()
				emitCanceledWaiter := func() {
					if errors.Is(context.Cause(rctx), errSearchSuperseded) {
						select {
						case output <- canceledEnvelope(m):
						case <-runCtx.Done():
						}
					}
				}
				select {
				case s.searchPermits <- struct{}{}:
				case <-rctx.Done():
					emitCanceledWaiter()
					return
				}
				defer func() { <-s.searchPermits }()
				select {
				case sem <- struct{}{}:
				case <-rctx.Done():
					emitCanceledWaiter()
					return
				}
				defer func() { <-sem }()
				defer cancel(context.Canceled)
				searchCtx, cancelSearch := context.WithTimeout(rctx, searchRequestTimeout)
				defer cancelSearch()
				s.runSearch(searchCtx, req.PluginContext, m, func(env responseEnvelope) error {
					select {
					case output <- env:
						return nil
					case <-runCtx.Done():
						return runCtx.Err()
					}
				})
			}(msg, reqCtx, cancel)
		}
	}
}

func searchAPIEnabled(pluginContext backend.PluginContext) bool {
	if pluginContext.DataSourceInstanceSettings == nil {
		return false
	}
	options, err := models.ParsePromOptions(*pluginContext.DataSourceInstanceSettings)
	return err == nil && options.EnableSearchAPI
}

// runSearch executes a single upstream search read and forwards frames. It guarantees a
// single terminal frame per requestId: if the upstream omitted a trailer (abrupt EOF) a
// synthetic terminal frame is sent so the frontend promise/observable always settles.
// A request superseded by newer work in the same slot emits one explicit cancellation
// response; whole-stream cancellation stays silent because the sender is closing.
func (s *Service) runSearch(ctx context.Context, pCtx backend.PluginContext, m publishMsg, emit func(responseEnvelope) error) {
	sawTerminal := false

	err := s.StreamSearch(ctx, pCtx, m.endpoint, m.params, func(line resource.SearchLine) error {
		env := envelopeFromLine(m, line)
		if env.Type == "terminal" || env.Type == "error" {
			sawTerminal = true
		}
		return emit(env)
	})

	if err != nil {
		if !sawTerminal && errors.Is(context.Cause(ctx), errSearchSuperseded) {
			_ = emit(canceledEnvelope(m))
			return
		}
		if errors.Is(err, context.Canceled) {
			return
		}
		if errors.Is(err, context.DeadlineExceeded) {
			_ = emit(responseEnvelope{
				RequestID: m.requestID, SlotID: m.slotID, Type: "error", Error: "search request timed out",
			})
			return
		}
		if s.logger != nil {
			s.logger.Warn("search stream read failed", "endpoint", m.endpoint, "error", err)
		}
		_ = emit(responseEnvelope{
			RequestID: m.requestID, SlotID: m.slotID, Type: "error", Error: err.Error(),
		})
		return
	}

	if !sawTerminal {
		// Abrupt EOF without a trailer: treat collected results as complete.
		_ = emit(responseEnvelope{RequestID: m.requestID, SlotID: m.slotID, Type: "terminal"})
	}
}

func canceledEnvelope(m publishMsg) responseEnvelope {
	return responseEnvelope{
		RequestID: m.requestID, SlotID: m.slotID, Type: "error",
		Error: "search request canceled", ErrorType: "canceled",
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

func writeEnvelopes(ctx context.Context, sender *backend.StreamSender, output <-chan responseEnvelope) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case env, ok := <-output:
			if !ok {
				return nil
			}
			if err := sendEnvelope(sender, env); err != nil {
				return err
			}
		}
	}
}
