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
	require.Equal(t, "max_samples_processed_warning_threshold", warningThresholdKey)
	require.Equal(t, "max_samples_processed_error_threshold", errorThresholdKey)

	finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK}, nil
	})

	t.Run("Without custom query parameters set should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 0, 0, false)
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

	t.Run("With custom query parameters set as empty string should not apply middleware", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "custom=%%abc&test=abc", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "custom=par/am&second=f oo", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "custom=par/am&second=f oo", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 500, 1000, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "custom=value", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
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
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "timeout=30s", 42, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
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

	t.Run("With explicit threshold fields and matching custom query parameters should prefer threshold fields", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "max_samples_processed_warning_threshold=9&max_samples_processed_error_threshold=17", 42, 88, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
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
		require.Equal(t, "42", q.Get(warningThresholdKey))
		require.Equal(t, "88", q.Get(errorThresholdKey))
	})

	t.Run("With query statistics disabled should not add stats", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 0, 0, false)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		req, err := http.NewRequest(http.MethodGet, "http://test.com/api/v1/query?query=up", nil)
		require.NoError(t, err)

		_, err = rt.RoundTrip(req)
		require.NoError(t, err)
		require.Empty(t, req.URL.Query().Get(queryStatsKey))
	})

	for _, tc := range []struct {
		name   string
		method string
		path   string
	}{
		{name: "GET instant query", method: http.MethodGet, path: "/api/v1/query"},
		{name: "POST instant query", method: http.MethodPost, path: "/api/v1/query"},
		{name: "GET range query", method: http.MethodGet, path: "/api/v1/query_range"},
		{name: "POST range query", method: http.MethodPost, path: "/api/v1/query_range"},
		{name: "query with workspace base path", method: http.MethodPost, path: "/workspaces/ws-123/api/v1/query"},
	} {
		t.Run("With query statistics enabled should add stats for "+tc.name, func(t *testing.T) {
			mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 0, 0, true)
			rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
			req, err := http.NewRequest(tc.method, "http://test.com"+tc.path+"?query=up&existing=value", nil)
			require.NoError(t, err)

			_, err = rt.RoundTrip(req)
			require.NoError(t, err)
			require.Equal(t, queryStatsValue, req.URL.Query().Get(queryStatsKey))
			require.Equal(t, "up", req.URL.Query().Get("query"))
			require.Equal(t, "value", req.URL.Query().Get("existing"))
		})
	}

	for _, path := range []string{
		"/api/v1/query_exemplars",
		"/api/v1/metadata",
		"/api/v1/labels",
		"/api/v1/series",
		"/api/v1/status/buildinfo",
	} {
		t.Run("With query statistics enabled should not add stats to non-query endpoint "+path, func(t *testing.T) {
			mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "", 0, 0, true)
			rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
			req, err := http.NewRequest(http.MethodGet, "http://test.com"+path, nil)
			require.NoError(t, err)

			_, err = rt.RoundTrip(req)
			require.NoError(t, err)
			require.Empty(t, req.URL.Query().Get(queryStatsKey))
		})
	}

	t.Run("Explicit query statistics setting should override a custom stats value", func(t *testing.T) {
		mw := CustomQueryParameters(backend.NewLoggerWith("logger", "test"), "stats=none&timeout=30s", 0, 0, true)
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		req, err := http.NewRequest(http.MethodPost, "http://test.com/api/v1/query_range", nil)
		require.NoError(t, err)

		_, err = rt.RoundTrip(req)
		require.NoError(t, err)
		require.Equal(t, []string{queryStatsValue}, req.URL.Query()[queryStatsKey])
		require.Equal(t, "30s", req.URL.Query().Get("timeout"))
	})
}
