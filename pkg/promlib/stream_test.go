package promlib

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

const (
	validSearchPath       = "search/550e8400-e29b-41d4-a716-446655440000"
	otherValidSearchPath  = "search/550e8400-e29b-41d4-a716-446655440001"
	cancelValidSearchPath = "search/550e8400-e29b-41d4-a716-446655440002"
)

func newTestService() *Service {
	return NewService(sdkhttpclient.NewProvider(), log.DefaultLogger, nil)
}

func enabledPluginContext() backend.PluginContext {
	return backend.PluginContext{
		User: &backend.User{Login: "test-user", Email: "test@example.com", Name: "Test User", Role: "Editor"},
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			JSONData: []byte(`{"enableSearchApi":true}`),
		},
	}
}

func testRequesterIdentity() requesterIdentity {
	identity, ok := requesterIdentityFromPluginContext(enabledPluginContext())
	if !ok {
		panic("test requester identity is unavailable")
	}
	return identity
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

type failingSender struct {
	err     error
	entered chan struct{}
	once    sync.Once
}

func (s *failingSender) Send(_ *backend.StreamPacket) error {
	s.once.Do(func() { close(s.entered) })
	return s.err
}

func TestSubscribeStream_AllowlistAndMailbox(t *testing.T) {
	svc := newTestService()
	pluginContext := enabledPluginContext()

	resp, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path: validSearchPath, PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusOK, resp.Status)
	_, ok := svc.getMailbox(validSearchPath)
	assert.True(t, ok, "mailbox should be created on subscribe")

	resp, err = svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path: "other/x", PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, resp.Status)
	_, ok = svc.getMailbox("other/x")
	assert.False(t, ok)
}

func TestSubscribeStream_EnforcesDatasourceChannelBudget(t *testing.T) {
	svc := newTestService()
	pluginContext := enabledPluginContext()
	for i := 0; i < 32; i++ {
		resp, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
			Path:          fmt.Sprintf("search/550e8400-e29b-41d4-a716-%012x", i),
			PluginContext: pluginContext,
		})
		require.NoError(t, err)
		require.Equal(t, backend.SubscribeStreamStatusOK, resp.Status)
	}

	resp, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path:          "search/550e8400-e29b-41d4-a716-ffffffffffff",
		PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, resp.Status)
}

func TestStreamHandlers_RejectMalformedSearchChannelPaths(t *testing.T) {
	svc := newTestService()
	pluginContext := enabledPluginContext()
	validPayload := mustJSON(publishPayload{RequestID: "r1", Endpoint: resource.SearchMetricNames})

	for _, path := range []string{
		"search/",
		"search/not-a-uuid",
		"search/550e8400-e29b-41d4-a716-446655440000/extra",
		"search/../550e8400-e29b-41d4-a716-446655440000",
	} {
		t.Run(path, func(t *testing.T) {
			subscribe, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
				Path: path, PluginContext: pluginContext,
			})
			require.NoError(t, err)
			assert.Equal(t, backend.SubscribeStreamStatusNotFound, subscribe.Status)

			svc.createMailbox(path, testRequesterIdentity())
			publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
				Path: path, Data: validPayload, PluginContext: pluginContext,
			})
			require.NoError(t, err)
			assert.Equal(t, backend.PublishStreamStatusPermissionDenied, publish.Status)
		})
	}
}

func TestStreamHandlers_RejectRequestsWhenSearchAPIIsDisabled(t *testing.T) {
	svc := newTestService()
	pluginContext := backend.PluginContext{
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			JSONData: []byte(`{"enableSearchApi":false}`),
		},
	}

	subscribe, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path:          "search/disabled",
		PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, subscribe.Status)

	svc.createMailbox("search/disabled", requesterIdentity{})
	publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path:          "search/disabled",
		PluginContext: pluginContext,
		Data:          mustJSON(publishPayload{RequestID: "r1", Endpoint: resource.SearchMetricNames}),
	})
	require.NoError(t, err)
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, publish.Status)

	runResult := make(chan error, 1)
	runContext, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	go func() {
		runResult <- svc.RunStream(runContext, &backend.RunStreamRequest{
			Path:          "search/disabled",
			PluginContext: pluginContext,
		}, backend.NewStreamSender(&recordingSender{}))
	}()
	select {
	case err := <-runResult:
		require.Error(t, err)
		assert.Contains(t, err.Error(), "disabled")
	case <-time.After(time.Second):
		t.Fatal("RunStream did not reject a disabled datasource")
	}
}

func TestStreamHandlers_RejectOAuthPassThruDatasource(t *testing.T) {
	svc := newTestService()
	pluginContext := backend.PluginContext{
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			JSONData: []byte(`{"enableSearchApi":true,"oauthPassThru":true}`),
		},
	}

	subscribe, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, subscribe.Status)

	svc.createMailbox(validSearchPath, testRequesterIdentity())
	publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
		Data:          mustJSON(publishPayload{RequestID: "r1", Endpoint: resource.SearchMetricNames}),
	})
	require.NoError(t, err)
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, publish.Status)

	runErr := svc.RunStream(context.Background(), &backend.RunStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
	}, backend.NewStreamSender(&recordingSender{}))
	require.Error(t, runErr)
	assert.Contains(t, runErr.Error(), "disabled")
}

func TestStreamHandlers_RejectKeepCookiesDatasource(t *testing.T) {
	svc := newTestService()
	pluginContext := backend.PluginContext{
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			JSONData: []byte(`{"enableSearchApi":true,"keepCookies":["session"]}`),
		},
	}

	subscribe, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
	})
	require.NoError(t, err)
	assert.Equal(t, backend.SubscribeStreamStatusNotFound, subscribe.Status)

	svc.createMailbox(validSearchPath, testRequesterIdentity())
	publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
		Data:          mustJSON(publishPayload{RequestID: "r1", Endpoint: resource.SearchMetricNames}),
	})
	require.NoError(t, err)
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, publish.Status)

	runErr := svc.RunStream(context.Background(), &backend.RunStreamRequest{
		Path:          validSearchPath,
		PluginContext: pluginContext,
	}, backend.NewStreamSender(&recordingSender{}))
	require.Error(t, runErr)
	assert.Contains(t, runErr.Error(), "disabled")
}

func TestPublishStream_Validation(t *testing.T) {
	svc := newTestService()
	svc.createMailbox(validSearchPath, testRequesterIdentity())
	pluginContext := enabledPluginContext()

	// wrong channel namespace
	resp, _ := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: "other/x", Data: []byte(`{}`), PluginContext: pluginContext,
	})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// invalid endpoint
	bad := mustJSON(publishPayload{RequestID: "r1", Endpoint: "series"})
	resp, _ = svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: validSearchPath, Data: bad, PluginContext: pluginContext,
	})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// missing requestId
	noReq := mustJSON(publishPayload{Endpoint: resource.SearchMetricNames})
	resp, _ = svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: validSearchPath, Data: noReq, PluginContext: pluginContext,
	})
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)

	// no mailbox for path
	good := mustJSON(publishPayload{RequestID: "r1", SlotID: "s1", Endpoint: resource.SearchMetricNames})
	resp, _ = svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: otherValidSearchPath, Data: good, PluginContext: pluginContext,
	})
	assert.Equal(t, backend.PublishStreamStatusNotFound, resp.Status)

	// valid publish routes to the mailbox
	valid := mustJSON(publishPayload{RequestID: "r1", SlotID: "s1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"up"}}})
	resp, _ = svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: validSearchPath, Data: valid, PluginContext: pluginContext,
	})
	assert.Equal(t, backend.PublishStreamStatusOK, resp.Status)

	mb, _ := svc.getMailbox(validSearchPath)
	if msg, _, ok := mb.next(); ok {
		assert.Equal(t, "r1", msg.requestID)
		assert.Equal(t, resource.SearchMetricNames, msg.endpoint)
		assert.Equal(t, "up", msg.params.Get("search[]"))
	} else {
		t.Fatal("expected message in mailbox")
	}
}

func TestPublishStream_BoundsClientControlledWork(t *testing.T) {
	svc := newTestService()
	svc.createMailbox(validSearchPath, testRequesterIdentity())
	pluginContext := enabledPluginContext()

	tests := []struct {
		name    string
		payload publishPayload
	}{
		{name: "invalid request ID", payload: publishPayload{
			RequestID: strings.Repeat("r", 129), SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
		}},
		{name: "invalid slot ID", payload: publishPayload{
			RequestID: "request-1", SlotID: "../slot", Endpoint: resource.SearchMetricNames,
		}},
		{name: "unknown parameter", payload: publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"redirect": {"https://example.com"}},
		}},
		{name: "too many search terms", payload: publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"search[]": {"1", "2", "3", "4", "5", "6"}},
		}},
		{name: "oversized parameter value", payload: publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"match[]": {strings.Repeat("x", 4097)}},
		}},
		{name: "invalid time range", payload: publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"start": {"200"}, "end": {"100"}},
		}},
		{name: "unlimited results", payload: publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"limit": {"0"}},
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
				Path: validSearchPath, PluginContext: pluginContext, Data: mustJSON(tc.payload),
			})
			require.NoError(t, err)
			assert.Equal(t, backend.PublishStreamStatusPermissionDenied, resp.Status)
		})
	}

	resp, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: pluginContext,
		Data: mustJSON(publishPayload{
			RequestID: "request-clamped", SlotID: "slot-clamped", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{
				"start":      {"1"},
				"end":        {strconv.FormatInt(1+int64((91*24*time.Hour)/time.Second), 10)},
				"batch_size": {"999999"},
				"limit":      {"999999"},
			},
		}),
	})
	require.NoError(t, err)
	require.Equal(t, backend.PublishStreamStatusOK, resp.Status)
	mb, _ := svc.getMailbox(validSearchPath)
	msg, _, ok := mb.next()
	require.True(t, ok)
	assert.Equal(t, "10000", msg.params.Get("limit"))
	assert.Equal(t, "1000", msg.params.Get("batch_size"))
	assert.Equal(t, strconv.FormatInt(1+int64((24*time.Hour)/time.Second), 10), msg.params.Get("start"))
}

func TestPublishStream_RejectsMismatchedMailboxOwner(t *testing.T) {
	svc := newTestService()
	ownerContext := enabledPluginContext()
	ownerContext.User = &backend.User{Login: "alice", Email: "alice@example.com", Name: "Alice", Role: "Editor"}
	resp, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path: validSearchPath, PluginContext: ownerContext,
	})
	require.NoError(t, err)
	require.Equal(t, backend.SubscribeStreamStatusOK, resp.Status)

	publisherContext := enabledPluginContext()
	publisherContext.User = &backend.User{Login: "bob", Email: "bob@example.com", Name: "Bob", Role: "Editor"}
	publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: publisherContext,
		Data: mustJSON(publishPayload{
			RequestID: "request-1", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
		}),
	})
	require.NoError(t, err)
	assert.Equal(t, backend.PublishStreamStatusPermissionDenied, publish.Status)
}

func TestEnqueue_CoalescesWithoutEvictingOtherSlots(t *testing.T) {
	mb := newSearchMailbox(testRequesterIdentity())
	enqueue(mb, publishMsg{requestID: "unrelated", slotID: "other"})
	for i := 0; i < mailboxBuffer+5; i++ {
		enqueue(mb, publishMsg{requestID: fmt.Sprintf("hot-%d", i), slotID: "hot"})
	}

	foundUnrelated := false
	foundNewest := false
	for {
		msg, _, ok := mb.next()
		if !ok {
			assert.True(t, foundUnrelated, "a hot slot must not evict another slot")
			assert.True(t, foundNewest, "the hot slot should retain its newest request")
			return
		}
		foundUnrelated = foundUnrelated || msg.requestID == "unrelated"
		foundNewest = foundNewest || msg.requestID == fmt.Sprintf("hot-%d", mailboxBuffer+4)
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
		User:  &backend.User{Login: "test-user", Email: "test@example.com", Name: "Test User", Role: "Editor"},
		DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
			UID:      "uid-1",
			URL:      serverURL,
			JSONData: []byte(`{"httpMethod":"GET","enableSearchApi":true}`),
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

	svc := newTestService()
	const path = otherValidSearchPath
	svc.createMailbox(path, testRequesterIdentity())

	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = svc.RunStream(ctx, &backend.RunStreamRequest{Path: path, PluginContext: testPluginContext(srv.URL)}, backend.NewStreamSender(sender))
	}()

	_, err := svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path:          path,
		PluginContext: testPluginContext(srv.URL),
		Data:          mustJSON(publishPayload{RequestID: "req-A", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"up"}}}),
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

func TestRunStream_WriterFailureCancelsUpstreamAndReturns(t *testing.T) {
	upstreamCanceled := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(`{"results":[{"name":"up"}]}` + "\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		<-req.Context().Done()
		close(upstreamCanceled)
	}))
	defer srv.Close()

	svc := newTestService()
	svc.createMailbox(validSearchPath, testRequesterIdentity())
	senderErr := errors.New("stream send failed")
	sender := &failingSender{err: senderErr, entered: make(chan struct{})}
	runResult := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		runResult <- svc.RunStream(ctx, &backend.RunStreamRequest{
			Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		}, backend.NewStreamSender(sender))
	}()

	_, err := svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path:          validSearchPath,
		PluginContext: testPluginContext(srv.URL),
		Data: mustJSON(publishPayload{
			RequestID: "req-writer-failure", SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
		}),
	})
	require.NoError(t, err)

	select {
	case err := <-runResult:
		require.ErrorIs(t, err, senderErr)
	case <-time.After(time.Second):
		t.Fatal("RunStream did not return the writer failure")
	}
	select {
	case <-upstreamCanceled:
	case <-time.After(time.Second):
		t.Fatal("writer failure did not cancel the upstream request")
	}
}

func TestRunStream_ControlLoopRemainsResponsiveAtConcurrencyLimit(t *testing.T) {
	started := make(chan string, maxConcurrentSlots+1)
	canceled := make(chan string, maxConcurrentSlots+1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requestID := req.URL.Query().Get("search[]")
		started <- requestID
		<-req.Context().Done()
		canceled <- requestID
	}))
	defer srv.Close()

	svc := newTestService()
	svc.createMailbox(validSearchPath, testRequesterIdentity())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = svc.RunStream(ctx, &backend.RunStreamRequest{
			Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		}, backend.NewStreamSender(&recordingSender{}))
	}()

	for i := 0; i < maxConcurrentSlots; i++ {
		id := fmt.Sprintf("request-%d", i)
		_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
			Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
			Data: mustJSON(publishPayload{
				RequestID: id, SlotID: fmt.Sprintf("slot-%d", i), Endpoint: resource.SearchMetricNames,
				Params: map[string][]string{"search[]": {id}},
			}),
		})
	}
	for i := 0; i < maxConcurrentSlots; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("did not saturate upstream concurrency")
		}
	}

	// This request waits for a permit. It must not block the mailbox loop from
	// consuming the following request, which supersedes and cancels slot-0.
	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		Data: mustJSON(publishPayload{
			RequestID: "waiting", SlotID: "slot-waiting", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"search[]": {"waiting"}},
		}),
	})
	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		Data: mustJSON(publishPayload{
			RequestID: "replacement", SlotID: "slot-0", Endpoint: resource.SearchMetricNames,
			Params: map[string][]string{"search[]": {"replacement"}},
		}),
	})

	select {
	case id := <-canceled:
		assert.Equal(t, "request-0", id)
	case <-time.After(time.Second):
		t.Fatal("mailbox control loop blocked while concurrency was saturated")
	}
}

func TestRunStream_EnforcesDatasourceUpstreamBudget(t *testing.T) {
	started := make(chan struct{}, 24)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		started <- struct{}{}
		<-req.Context().Done()
	}))
	defer srv.Close()

	svc := newTestService()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	for channel := 0; channel < 3; channel++ {
		path := fmt.Sprintf("search/550e8400-e29b-41d4-a716-%012x", 100+channel)
		svc.createMailbox(path, testRequesterIdentity())
		go func() {
			_ = svc.RunStream(ctx, &backend.RunStreamRequest{
				Path: path, PluginContext: testPluginContext(srv.URL),
			}, backend.NewStreamSender(&recordingSender{}))
		}()
		for slot := 0; slot < maxConcurrentSlots; slot++ {
			id := fmt.Sprintf("request-%d-%d", channel, slot)
			_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
				Path: path, PluginContext: testPluginContext(srv.URL),
				Data: mustJSON(publishPayload{
					RequestID: id, SlotID: fmt.Sprintf("slot-%d", slot), Endpoint: resource.SearchMetricNames,
					Params: map[string][]string{"search[]": {id}},
				}),
			})
		}
	}

	for i := 0; i < 16; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("datasource did not use its available upstream budget")
		}
	}
	select {
	case <-started:
		t.Fatal("datasource exceeded its upstream concurrency budget")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestServiceDispose_CancelsActiveRunStreams(t *testing.T) {
	upstreamStarted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		close(upstreamStarted)
		<-req.Context().Done()
	}))
	defer srv.Close()

	svc := newTestService()
	svc.createMailbox(validSearchPath, testRequesterIdentity())
	parent, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	runResult := make(chan error, 1)
	go func() {
		runResult <- svc.RunStream(parent, &backend.RunStreamRequest{
			Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		}, backend.NewStreamSender(&recordingSender{}))
	}()
	_, _ = svc.PublishStream(parent, &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: testPluginContext(srv.URL),
		Data: mustJSON(publishPayload{
			RequestID: "request-dispose", SlotID: "slot-dispose", Endpoint: resource.SearchMetricNames,
		}),
	})
	select {
	case <-upstreamStarted:
	case <-time.After(time.Second):
		t.Fatal("upstream request did not start")
	}

	svc.Dispose()

	select {
	case err := <-runResult:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(time.Second):
		t.Fatal("Dispose did not cancel the active RunStream")
	}
	assert.NoError(t, parent.Err(), "service disposal must own cancellation")
	_, exists := svc.getMailbox(validSearchPath)
	assert.False(t, exists, "disposed service retained mailbox state")
}

func TestRunStream_CancelPrevious(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	doRelease := func() { releaseOnce.Do(func() { close(release) }) }
	defer doRelease()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		fl, _ := w.(http.Flusher)
		switch req.URL.Query().Get("search[]") {
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

	svc := newTestService()
	const path = cancelValidSearchPath
	svc.createMailbox(path, testRequesterIdentity())

	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = svc.RunStream(ctx, &backend.RunStreamRequest{Path: path, PluginContext: testPluginContext(srv.URL)}, backend.NewStreamSender(sender))
	}()

	// First request on slot-1: slow, will block upstream.
	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path:          path,
		PluginContext: testPluginContext(srv.URL),
		Data:          mustJSON(publishPayload{RequestID: "req-slow", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"slow"}}}),
	})
	// Wait until the slow batch is in-flight.
	waitForEnvelope(t, sender, func(e responseEnvelope) bool { return e.RequestID == "req-slow" && e.Type == "batch" })

	// Second request on the SAME slot supersedes the first -> cancel-previous.
	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path:          path,
		PluginContext: testPluginContext(srv.URL),
		Data:          mustJSON(publishPayload{RequestID: "req-fast", SlotID: "slot-1", Endpoint: resource.SearchMetricNames, Params: map[string][]string{"search[]": {"fast"}}}),
	})

	// req-fast completes with a terminal and the superseded request settles once with
	// an explicit cancellation response.
	waitForEnvelope(t, sender, func(e responseEnvelope) bool { return e.RequestID == "req-fast" && e.Type == "terminal" })
	waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "req-slow" && e.Type == "error" && e.ErrorType == "canceled"
	})
	cancellationCount := 0
	for _, e := range sender.envelopes() {
		if e.RequestID == "req-slow" && e.Type == "error" && e.ErrorType == "canceled" {
			cancellationCount++
		}
	}
	assert.Equal(t, 1, cancellationCount)

	doRelease()
}

func TestRunStream_SettledSlotsAreForgotten(t *testing.T) {
	slots := newSlotRegistry()
	var canceled []string

	firstGeneration := slots.replace("metric-names|monaco", func(error) {
		canceled = append(canceled, "first")
	})
	secondGeneration := slots.replace("metric-names|monaco", func(error) {
		canceled = append(canceled, "second")
	})

	assert.Equal(t, []string{"first"}, canceled)
	slots.finish(slotCompletion{key: "metric-names|monaco", generation: firstGeneration})
	assert.Len(t, slots.entries, 1, "stale completion removed the replacement")

	slots.finish(slotCompletion{key: "metric-names|monaco", generation: secondGeneration})
	assert.Empty(t, slots.entries, "settled slot retained its cancel function")
}

func TestRunStream_CoalescedRequestReceivesCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success"}` + "\n"))
	}))
	defer srv.Close()

	svc := newTestService()
	pluginContext := testPluginContext(srv.URL)
	subscribe, err := svc.SubscribeStream(context.Background(), &backend.SubscribeStreamRequest{
		Path: validSearchPath, PluginContext: pluginContext,
	})
	require.NoError(t, err)
	require.Equal(t, backend.SubscribeStreamStatusOK, subscribe.Status)
	for _, requestID := range []string{"request-old", "request-new"} {
		publish, err := svc.PublishStream(context.Background(), &backend.PublishStreamRequest{
			Path: validSearchPath, PluginContext: pluginContext,
			Data: mustJSON(publishPayload{
				RequestID: requestID, SlotID: "slot-1", Endpoint: resource.SearchMetricNames,
			}),
		})
		require.NoError(t, err)
		require.Equal(t, backend.PublishStreamStatusOK, publish.Status)
	}

	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = svc.RunStream(ctx, &backend.RunStreamRequest{
			Path: validSearchPath, PluginContext: pluginContext,
		}, backend.NewStreamSender(sender))
	}()

	waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "request-new" && e.Type == "terminal"
	})
	waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "request-old" && e.Type == "error" && e.ErrorType == "canceled"
	})
}

func TestRunStream_PermitWaiterReceivesCancellation(t *testing.T) {
	started := make(chan struct{}, maxConcurrentSlots)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		started <- struct{}{}
		<-req.Context().Done()
	}))
	defer srv.Close()

	svc := newTestService()
	pluginContext := testPluginContext(srv.URL)
	mb := svc.createMailbox(validSearchPath, testRequesterIdentity())
	sender := &recordingSender{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = svc.RunStream(ctx, &backend.RunStreamRequest{
			Path: validSearchPath, PluginContext: pluginContext,
		}, backend.NewStreamSender(sender))
	}()
	for i := 0; i < maxConcurrentSlots; i++ {
		id := fmt.Sprintf("active-%d", i)
		_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
			Path: validSearchPath, PluginContext: pluginContext,
			Data: mustJSON(publishPayload{
				RequestID: id, SlotID: id, Endpoint: resource.SearchMetricNames,
				Params: map[string][]string{"search[]": {id}},
			}),
		})
	}
	for i := 0; i < maxConcurrentSlots; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("did not saturate per-channel permits")
		}
	}

	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: pluginContext,
		Data: mustJSON(publishPayload{
			RequestID: "waiting-old", SlotID: "waiting-slot", Endpoint: resource.SearchMetricNames,
		}),
	})
	require.Eventually(t, func() bool {
		mb.mu.Lock()
		defer mb.mu.Unlock()
		_, pending := mb.pending[resource.SearchMetricNames+"|waiting-slot"]
		return !pending
	}, time.Second, time.Millisecond)
	_, _ = svc.PublishStream(ctx, &backend.PublishStreamRequest{
		Path: validSearchPath, PluginContext: pluginContext,
		Data: mustJSON(publishPayload{
			RequestID: "waiting-new", SlotID: "waiting-slot", Endpoint: resource.SearchMetricNames,
		}),
	})

	waitForEnvelope(t, sender, func(e responseEnvelope) bool {
		return e.RequestID == "waiting-old" && e.Type == "error" && e.ErrorType == "canceled"
	})
}
