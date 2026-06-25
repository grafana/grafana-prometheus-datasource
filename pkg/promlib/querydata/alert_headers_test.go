package querydata_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
)

// These tests reproduce the externalization regression where alerting headers
// (FromAlert, X-Rule-*) set on the backend.QueryDataRequest do NOT reach the
// upstream Prometheus HTTP request when the plugin runs as an external
// (out-of-process) backend.
//
// In-process, core Grafana's HTTPClientMiddleware copies these headers onto the
// outgoing request. That middleware lives in the parent Grafana process and does
// not cross the gRPC boundary into an external plugin. Inside the external plugin,
// the only equivalent is the SDK's plugin-side header forwarding, which:
//   - is installed by datasource.Manage (replicated by withSDKHeaderForwarding below),
//   - only forwards headers exposed via req.GetHTTPHeaders() (i.e. the "http_"-prefixed
//     ones such as http_X-Rule-*), and
//   - only fires when the HTTP client opts in via opts.ForwardHTTPHeaders AND the
//     client chain contains httpclient.ContextualMiddleware().
//
// Prometheus' CreateTransportOptions does neither today, so nothing is forwarded.

// captured records the headers of the last outgoing request to the upstream.
type captured struct {
	mu      sync.Mutex
	headers http.Header
}

func (c *captured) set(h http.Header) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.headers = h.Clone()
}

func (c *captured) get() http.Header {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.headers
}

// captureMiddleware is installed as the innermost HTTP client middleware so it
// observes the request exactly as it would go out on the wire, then returns a
// canned successful Prometheus response instead of hitting the network.
func captureMiddleware(c *captured) httpclient.Middleware {
	return httpclient.NamedMiddlewareFunc("test-capture", func(_ httpclient.Options, _ http.RoundTripper) http.RoundTripper {
		return httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			c.set(req.Header)
			body := `{"status":"success","data":{"resultType":"matrix","result":[]}}`
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"application/json"}},
				Body:       io.NopCloser(bytes.NewReader([]byte(body))),
				Request:    req,
			}, nil
		})
	})
}

// withSDKHeaderForwarding mirrors grafana-plugin-sdk-go's headerMiddleware
// (backend/http_headers.go), which datasource.Manage installs for every plugin.
// It stores a contextual HTTP middleware that forwards req.GetHTTPHeaders() to the
// outgoing request, but only when opts.ForwardHTTPHeaders is enabled.
func withSDKHeaderForwarding(ctx context.Context, req *backend.QueryDataRequest) context.Context {
	headers := req.GetHTTPHeaders()
	if len(headers) == 0 {
		return ctx
	}
	return httpclient.WithContextualMiddleware(ctx,
		httpclient.MiddlewareFunc(func(opts httpclient.Options, next http.RoundTripper) http.RoundTripper {
			if !opts.ForwardHTTPHeaders {
				return next
			}
			return httpclient.RoundTripperFunc(func(qreq *http.Request) (*http.Response, error) {
				for k, v := range headers {
					if qreq.Header.Get(k) == "" {
						for _, vv := range v {
							qreq.Header.Add(k, vv)
						}
					}
				}
				return next.RoundTrip(qreq)
			})
		}))
}

// newExternalQueryData builds a QueryData wired exactly like the external plugin
// in pkg/datasource.go: production CreateTransportOptions + a bare SDK provider.
// A capture middleware is appended last so it sees the final outgoing headers.
func newExternalQueryData(t *testing.T, c *captured) *querydata.QueryData {
	t.Helper()

	settings := backend.DataSourceInstanceSettings{
		URL:      "http://localhost:9090",
		JSONData: []byte(`{"timeInterval":"15s"}`),
	}

	opts, err := client.CreateTransportOptions(context.Background(), settings, log.New())
	require.NoError(t, err)

	opts.Middlewares = append(opts.Middlewares, captureMiddleware(c))

	httpClient, err := httpclient.NewProvider().New(*opts)
	require.NoError(t, err)

	qd, err := querydata.New(httpClient, settings, log.New(), backend.FeatureToggles{})
	require.NoError(t, err)
	return qd
}

func alertQueryRequest(headers map[string]string) *backend.QueryDataRequest {
	now := time.Now()
	return &backend.QueryDataRequest{
		Headers: headers,
		Queries: []backend.DataQuery{
			{
				RefID: "A",
				TimeRange: backend.TimeRange{
					From: now.Add(-1 * time.Hour),
					To:   now,
				},
				JSON: []byte(`{"expr":"up","range":true,"refId":"A","intervalMs":15000}`),
			},
		},
		PluginContext: backend.PluginContext{
			GrafanaConfig: backend.NewGrafanaCfg(map[string]string{
				"concurrent_query_count": "10",
			}),
		},
	}
}

func TestQueryData_ForwardsAlertHeadersToUpstream(t *testing.T) {
	ctx := backend.WithGrafanaConfig(context.Background(), backend.NewGrafanaCfg(map[string]string{
		"concurrent_query_count": "10",
	}))

	// ngalert sets rule metadata as "http_X-Rule-*" and FromAlert as a plain key.
	headers := map[string]string{
		"FromAlert":        "true",
		"http_X-Rule-Uid":  "rule-abc-123",
		"http_X-Rule-Name": "High error rate",
	}

	t.Run("forwards X-Rule-* headers to the upstream Prometheus request", func(t *testing.T) {
		c := &captured{}
		qd := newExternalQueryData(t, c)

		req := alertQueryRequest(headers)
		reqCtx := withSDKHeaderForwarding(ctx, req)

		_, err := qd.Execute(reqCtx, req)
		require.NoError(t, err)

		got := c.get()
		require.NotNil(t, got, "no upstream request was captured")
		require.Equal(t, "rule-abc-123", got.Get("X-Rule-Uid"), "X-Rule-Uid must be forwarded to the upstream Prometheus")
		require.Equal(t, "High error rate", got.Get("X-Rule-Name"), "X-Rule-Name must be forwarded to the upstream Prometheus")
	})

	t.Run("forwards FromAlert header to the upstream Prometheus request", func(t *testing.T) {
		c := &captured{}
		qd := newExternalQueryData(t, c)

		req := alertQueryRequest(headers)
		reqCtx := withSDKHeaderForwarding(ctx, req)

		_, err := qd.Execute(reqCtx, req)
		require.NoError(t, err)

		got := c.get()
		require.NotNil(t, got, "no upstream request was captured")
		require.Equal(t, "true", got.Get("FromAlert"), "FromAlert must be forwarded to the upstream Prometheus")
	})
}
