package hostlimit

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/proxy"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"
)

type blockingTransport struct {
	entered chan struct{}
	release chan struct{}
	err     error
}

func newBlockingTransport() *blockingTransport {
	return &blockingTransport{entered: make(chan struct{}, 100), release: make(chan struct{})}
}

func (b *blockingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	b.entered <- struct{}{}
	<-b.release
	if b.err != nil {
		return nil, b.err
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), Request: req}, nil
}

func (b *blockingTransport) waitEntered(t *testing.T, n int) {
	t.Helper()
	for range n {
		select {
		case <-b.entered:
		case <-time.After(5 * time.Second):
			t.Fatal("request did not reach the transport")
		}
	}
}

type trackingBody struct {
	io.Reader
	closed bool
}

func (t *trackingBody) Close() error {
	t.closed = true
	return nil
}

type okTransport struct{}

func (okTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: req}, nil
}

func rejectionCount(t *testing.T) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	for _, family := range families {
		if family.GetName() == "grafana_prometheus_plugin_host_request_limit_rejections_total" {
			return family.Metric[0].GetCounter().GetValue()
		}
	}
	t.Fatal("host request limit rejection counter not found")
	return 0
}

func roundTripper(l *Limiter, opts sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
	return l.Middleware().CreateMiddleware(opts, next)
}

func newRequest(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, rawURL, nil)
	require.NoError(t, err)
	return req
}

func holdRequests(t *testing.T, rt http.RoundTripper, transport *blockingTransport, rawURL string, n int) {
	t.Helper()
	var wg sync.WaitGroup
	for range n {
		req := newRequest(t, rawURL)
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := rt.RoundTrip(req)
			if err == nil {
				_ = res.Body.Close()
			}
		}()
	}
	transport.waitEntered(t, n)
	t.Cleanup(func() {
		select {
		case <-transport.release:
		default:
			close(transport.release)
		}
		wg.Wait()
	})
}

func proxied(username string) sdkhttpclient.Options {
	return sdkhttpclient.Options{ProxyOptions: &proxy.Options{Enabled: true, Auth: &proxy.AuthOptions{Username: username}}}
}

func TestFromEnv(t *testing.T) {
	tests := []struct {
		name      string
		value     string
		wantLimit int
		wantErr   bool
	}{
		{name: "unset disables the limit", value: "", wantLimit: 0},
		{name: "zero disables the limit", value: "0", wantLimit: 0},
		{name: "positive value sets the limit", value: "250", wantLimit: 250},
		{name: "negative value is rejected", value: "-1", wantLimit: 0, wantErr: true},
		{name: "non-numeric value is rejected", value: "2,500", wantLimit: 0, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(EnvVar, tc.value)
			l, err := FromEnv()
			if tc.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			require.Equal(t, tc.wantLimit, l.Limit())
		})
	}
}

func TestMiddlewareRejectsRequestsOverTheLimit(t *testing.T) {
	transport := newBlockingTransport()
	rt := roundTripper(New(2), sdkhttpclient.Options{}, transport)
	holdRequests(t, rt, transport, "https://prometheus.example", 2)
	before := rejectionCount(t)

	body := &trackingBody{Reader: strings.NewReader("query=up")}
	req := newRequest(t, "https://prometheus.example/api/v1/query")
	req.Body = body
	res, err := rt.RoundTrip(req)

	require.Nil(t, res)
	require.ErrorIs(t, err, ErrLimitReached)
	require.True(t, backend.IsDownstreamError(err))
	require.True(t, body.closed)
	require.Equal(t, before+1, rejectionCount(t))
}

func TestMiddlewareKeysRequestsByDestination(t *testing.T) {
	tests := []struct {
		name       string
		heldOpts   sdkhttpclient.Options
		heldURL    string
		nextOpts   sdkhttpclient.Options
		nextURL    string
		wantReject bool
	}{
		{name: "same host with and without the default port", heldURL: "https://busy.example", nextURL: "https://busy.example:443/api/v1/query", wantReject: true},
		{name: "same host in a different case", heldURL: "https://Busy.Example", nextURL: "https://busy.example/api/v1/query", wantReject: true},
		{name: "different host", heldURL: "https://busy.example", nextURL: "https://other.example/api/v1/query", wantReject: false},
		{name: "different port", heldURL: "http://busy.example:9090", nextURL: "http://busy.example:9091/api/v1/query", wantReject: false},
		{name: "same host through the same proxy route", heldOpts: proxied("ds-a"), heldURL: "http://prometheus:9090", nextOpts: proxied("ds-a"), nextURL: "http://prometheus:9090/api/v1/query", wantReject: true},
		{name: "same host through different proxy routes", heldOpts: proxied("ds-a"), heldURL: "http://prometheus:9090", nextOpts: proxied("ds-b"), nextURL: "http://prometheus:9090/api/v1/query", wantReject: false},
		{name: "same host with and without a proxy", heldOpts: proxied("ds-a"), heldURL: "http://prometheus:9090", nextURL: "http://prometheus:9090/api/v1/query", wantReject: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			l := New(1)
			held := newBlockingTransport()
			holdRequests(t, roundTripper(l, tc.heldOpts, held), held, tc.heldURL, 1)

			res, err := roundTripper(l, tc.nextOpts, okTransport{}).RoundTrip(newRequest(t, tc.nextURL))

			if tc.wantReject {
				require.ErrorIs(t, err, ErrLimitReached)
				return
			}
			require.NoError(t, err)
			_ = res.Body.Close()
		})
	}
}

func TestMiddlewareReleasesTheSlotWhenTheRequestEnds(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{name: "after a response", err: nil},
		{name: "after a transport error", err: errors.New("dial tcp: i/o timeout")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			transport := newBlockingTransport()
			transport.err = tc.err
			close(transport.release)
			rt := roundTripper(New(1), sdkhttpclient.Options{}, transport)
			for range 3 {
				res, err := rt.RoundTrip(newRequest(t, "https://prometheus.example"))
				require.NotErrorIs(t, err, ErrLimitReached)
				transport.waitEntered(t, 1)
				if tc.err != nil {
					require.ErrorIs(t, err, tc.err)
					continue
				}
				require.NoError(t, err)
				_ = res.Body.Close()
			}
		})
	}
}

func TestMiddlewareWithoutALimitPassesRequestsThrough(t *testing.T) {
	transport := newBlockingTransport()
	rt := roundTripper(New(0), sdkhttpclient.Options{}, transport)
	require.Same(t, transport, rt)
}

func TestRejectionsSurfaceAsDownstreamHTTPErrors(t *testing.T) {
	transport := newBlockingTransport()
	client := &http.Client{Transport: roundTripper(New(1), sdkhttpclient.Options{}, transport)}
	holdRequests(t, client.Transport, transport, "https://prometheus.example", 1)

	_, err := client.Do(newRequest(t, "https://prometheus.example/api/v1/query"))

	require.ErrorIs(t, err, ErrLimitReached)
	require.True(t, backend.IsDownstreamHTTPError(err))
}

func BenchmarkMiddleware(b *testing.B) {
	benchmarks := []struct {
		name  string
		limit int
	}{
		{name: "disabled", limit: 0},
		{name: "enabled", limit: 1 << 20},
	}
	for _, bm := range benchmarks {
		b.Run(bm.name, func(b *testing.B) {
			rt := roundTripper(New(bm.limit), sdkhttpclient.Options{}, okTransport{})
			req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://prometheus.example/api/v1/query", nil)
			require.NoError(b, err)
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					res, err := rt.RoundTrip(req)
					if err != nil {
						b.Fatal(err)
					}
					_ = res.Body.Close()
				}
			})
		})
	}
}
