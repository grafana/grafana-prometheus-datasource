package datasource

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

func newTestDatasource() *Datasource {
	return &Datasource{
		Service:   promlib.NewService(sdkhttpclient.NewProvider(), log.DefaultLogger, nil),
		logger:    log.DefaultLogger,
		mailboxes: make(map[string]chan publishMsg),
	}
}

// recordingSender captures every JSON packet sent down the stream.
type recordingSender struct {
	mu      sync.Mutex
	packets [][]byte
}

func (s *recordingSender) Send(p *backend.StreamPacket) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := make([]byte, len(p.Data))
	copy(cp, p.Data)
	s.packets = append(s.packets, cp)
	return nil
}

func (s *recordingSender) envelopes() []responseEnvelope {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]responseEnvelope, 0, len(s.packets))
	for _, p := range s.packets {
		var env responseEnvelope
		if json.Unmarshal(p, &env) == nil {
			out = append(out, env)
		}
	}
	return out
}

func TestSubscribeStream_AllowlistAndMailbox(t *testing.T) {
	d := newTestDatasource()

	resp, err := d.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{Path: "search/sess-1"})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusOK, resp.Status)
	_, ok := d.getMailbox("search/sess-1")
	assert.True(t, ok, "mailbox should be created on subscribe")

	resp, err = d.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{Path: "other/x"})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, resp.Status)
	_, ok = d.getMailbox("other/x")
	assert.False(t, ok)
}

func TestPublishStream_Validation(t *testing.T) {
	d := newTestDatasource()
	d.createMailbox("search/sess-1")

	// wrong channel namespace
	resp, _ := d.PublishStream(context.Background(), &backend.PublishStreamRequest{Path: "other/x", Data: []byte(`{}`)})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// invalid endpoint
	bad := mustJSON(publishPayload{RequestID: "r1", Endpoint: "series"})
	resp, _ = d.PublishStream(context.Background(), &backend.PublishStreamRequest{Path: "search/sess-1", Data: bad})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// missing requestId
	noReq := mustJSON(publishPayload{Endpoint: resource.SearchMetricNames})
	resp, _ = d.PublishStream(context.Background(), &backend.PublishStreamRequest{Path: "search/sess-1", Data: noReq})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// no mailbox for path
	good := mustJSON(publishPayload{RequestID: "r1", Endpoint: resource.SearchMetricNames})
	resp, _ = d.PublishStream(context.Background(), &backend.PublishStreamRequest{Path: "search/no-mailbox", Data: good})
	assert.Equal(t, backend.PublishStreamStatusNotFound, resp.Status)

	// valid publish routes to the mailbox
	valid := mustJSON(publishPayload{RequestID: "r1", SlotID: "s1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"up"}}})
	resp, _ = d.PublishStream(context.Background(), &backend.PublishStreamRequest{Path: "search/sess-1", Data: valid})
	assert.Equal(t, backend.PublishStreamStatusOK, resp.Status)

	mb, _ := d.getMailbox("search/sess-1")
	select {
	case msg := <-mb:
		assert.Equal(t, "r1", msg.requestID)
		assert.Equal(t, resource.SearchMetricNames, msg.endpoint)
		assert.Equal(t, "up", msg.params.Get("search[]"))
	default:
		t.Fatal("expected message in mailbox")
	}
}

func TestEnqueue_LatestWins(t *testing.T) {
	mb := make(chan publishMsg, mailboxBuffer)
	// Overfill the buffer.
	for i := 0; i < mailboxBuffer+5; i++ {
		enqueue(mb, publishMsg{requestID: "old"})
	}
	enqueue(mb, publishMsg{requestID: "newest"})

	// Drain and ensure the newest is present and we never blocked.
	found := false
	for {
		select {
		case msg := <-mb:
			if msg.requestID == "newest" {
				found = true
			}
		default:
			assert.True(t, found, "newest message should survive latest-wins drop")
			return
		}
	}
}

func TestEnvelopeFromLine(t *testing.T) {
	m := publishMsg{requestID: "r1", slotID: "s1"}

	batch := envelopeFromLine(m, resource.SearchLine{Results: []json.RawMessage{json.RawMessage(`{"name":"up"}`)}, Warnings: []string{"w"}})
	assert.Equal(t, "batch", batch.Type)
	assert.Equal(t, "r1", batch.RequestID)
	assert.Len(t, batch.Results, 1)
	assert.Equal(t, []string{"w"}, batch.Warnings)

	term := envelopeFromLine(m, resource.SearchLine{Status: "success", HasMore: true})
	assert.Equal(t, "terminal", term.Type)
	assert.True(t, term.HasMore)

	errEnv := envelopeFromLine(m, resource.SearchLine{Status: "error", Error: "boom", ErrType: "internal"})
	assert.Equal(t, "error", errEnv.Type)
	assert.Equal(t, "boom", errEnv.Error)
	assert.Equal(t, "internal", errEnv.ErrorType)
}

func mustJSON(v interface{}) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func testPluginContext(serverURL string) backend.PluginContext {
	return backend.PluginContext{
		OrgID: 1,
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			UID:      "uid-1",
			URL:      serverURL,
			JSONData: []byte(`{"httpMethod":"GET"}`),
		},
	}
}

func waitForEnvelope(t *testing.T, sender *recordingSender, match func(responseEnvelope) bool) responseEnvelope {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		for _, env := range sender.envelopes() {
			if match(env) {
				return env
			}
		}
		select {
		case <-deadline:
			t.Fatal("timed out waiting for matching envelope")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestRunStream_EndToEnd_RequestIdTagging(t *testing.T) {
	body := `{"results":[{"name":"up"}]}` + "\n" + `{"status":"success","has_more":false}` + "\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		assert.Equal(t, "/api/v1/search/metric_names", req.URL.Path)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	d := newTestDatasource()
	const path = "search/sess-e2e"
	d.createMailbox(path)

	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = d.RunStream(ctx, &backend.RunStreamRequest{Path: path, PluginContext: testPluginContext(srv.URL)}, backend.NewStreamSender(sender))
	}()

	_, err := d.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: path,
		Data: mustJSON(publishPayload{RequestID: "req-A", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"up"}}}),
	})
	require.NoError(t, err)

	terminal := waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "req-A" && e.Type == "terminal"
	})
	assert.Equal(t, "slot-1", terminal.SlotID)

	// A batch tagged with the same requestId must also have been delivered.
	batch := waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "req-A" && e.Type == "batch"
	})
	assert.Len(t, batch.Results, 1)
}

func TestRunStream_CancelPrevious(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	doRelease := func() { releaseOnce.Do(func() { close(release) }) }
	defer doRelease()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fl, _ := w.(http.Flusher)
		switch req.URL.Query().Get("rid") {
		case "slow":
			_, _ = w.Write([]byte(`{"results":[{"name":"slow"}]}` + "\n"))
			if fl != nil {
				fl.Flush()
			}
			select {
			case <-release:
			case <-req.Context().Done():
			}
		default:
			_, _ = w.Write([]byte(`{"results":[{"name":"fast"}]}` + "\n" + `{"status":"success"}` + "\n"))
		}
	}))
	defer srv.Close()

	d := newTestDatasource()
	const path = "search/sess-cancel"
	d.createMailbox(path)

	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = d.RunStream(ctx, &backend.RunStreamRequest{Path: path, PluginContext: testPluginContext(srv.URL)}, backend.NewStreamSender(sender))
	}()

	// First request on slot-1: slow, will block upstream.
	_, _ = d.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: path,
		Data: mustJSON(publishPayload{RequestID: "req-slow", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"rid": {"slow"}}}),
	})
	// Wait until the slow batch is in-flight.
	waitForEnvelope(t, sender, func(e responseEnvelope) bool { return e.RequestID == "req-slow" && e.Type == "batch" })

	// Second request on the SAME slot supersedes the first -> cancel-previous.
	_, _ = d.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: path,
		Data: mustJSON(publishPayload{RequestID: "req-fast", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"rid": {"fast"}}}),
	})

	// req-fast completes with a terminal.
	waitForEnvelope(t, sender, func(e responseEnvelope) bool { return e.RequestID == "req-fast" && e.Type == "terminal" })

	// The superseded slow request must NOT have produced a terminal (it was cancelled,
	// so runSearch stays silent on context.Canceled).
	for _, e := range sender.envelopes() {
		if e.RequestID == "req-slow" {
			assert.NotEqual(t, "terminal", e.Type, "cancelled request should not emit a terminal frame")
		}
	}

	doRelease()
}
