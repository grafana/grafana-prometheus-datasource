package middleware

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/stretchr/testify/require"
)

func TestCustomQueryParametersMiddleware(t *testing.T) {
	require.Equal(t, "customQueryParameters", customQueryParametersKey)
	require.Equal(t, "maxSamplesProcessedWarningThreshold", warningThresholdKey)
	require.Equal(t, "maxSamplesProcessedErrorThreshold", errorThresholdKey)

	finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK}, nil
	})

	t.Run("Without custom query parameters set should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.Equal(t, "http://test.com/query?hello=name", req.URL.String())
	})

	t.Run("Without custom query parameters set as string should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				customQueryParametersKey: 64,
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.Equal(t, "http://test.com/query?hello=name", req.URL.String())
	})

	t.Run("With custom query parameters set as empty string should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				customQueryParametersKey: "",
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.Equal(t, "http://test.com/query?hello=name", req.URL.String())
	})

	t.Run("With custom query parameters set as invalid query string should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				customQueryParametersKey: "custom=%%abc&test=abc",
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.Equal(t, "http://test.com/query?hello=name", req.URL.String())
	})

	t.Run("With custom query parameters set should apply middleware for request URL containing query parameters ", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				grafanaDataKey: map[string]any{
					customQueryParametersKey: "custom=par/am&second=f oo",
				},
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.True(t, strings.HasPrefix(req.URL.String(), "http://test.com/query?"))

		q := req.URL.Query()
		require.Len(t, q, 3)
		require.Equal(t, "name", url.QueryEscape(q.Get("hello")))
		require.Equal(t, "par%2Fam", url.QueryEscape(q.Get("custom")))
		require.Equal(t, "f+oo", url.QueryEscape(q.Get("second")))
	})

	t.Run("With custom query parameters set should apply middleware for request URL not containing query parameters", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				grafanaDataKey: map[string]any{
					customQueryParametersKey: "custom=par/am&second=f oo",
				},
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, customQueryParametersMiddlewareName, middlewareName.MiddlewareName())

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		require.Equal(t, "http://test.com/query?custom=par%2Fam&second=f+oo", req.URL.String())
	})

	t.Run("With sample thresholds only should apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				grafanaDataKey: map[string]any{
					warningThresholdKey: float64(500),
					errorThresholdKey:   float64(1000),
				},
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://test.com/api/v1/query_range?query=up", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		q := req.URL.Query()
		require.Equal(t, "500", q.Get(warningThresholdKey))
		require.Equal(t, "1000", q.Get(errorThresholdKey))
		require.Equal(t, "up", q.Get("query"))
	})

	t.Run("With zero sample thresholds should not add threshold query params", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				grafanaDataKey: map[string]any{
					customQueryParametersKey: "custom=value",
					warningThresholdKey:        float64(0),
					errorThresholdKey:          float64(0),
				},
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query?hello=name", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		q := req.URL.Query()
		require.Equal(t, "name", q.Get("hello"))
		require.Equal(t, "value", q.Get("custom"))
		require.Empty(t, q.Get(warningThresholdKey))
		require.Empty(t, q.Get(errorThresholdKey))
	})

	t.Run("With custom query parameters and sample thresholds should merge query string", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"))
		rt := mw.CreateMiddleware(httpclient.Options{
			CustomOptions: map[string]any{
				grafanaDataKey: map[string]any{
					customQueryParametersKey: "timeout=30s",
					warningThresholdKey:      float64(42),
				},
			},
		}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://test.com/query", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		if res.Body != nil {
			require.NoError(t, res.Body.Close())
		}

		q := req.URL.Query()
		require.Equal(t, "30s", q.Get("timeout"))
		require.Equal(t, "42", q.Get(warningThresholdKey))
		require.Empty(t, q.Get(errorThresholdKey))
	})
}
