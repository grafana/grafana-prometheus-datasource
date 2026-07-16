package resource_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/resource"
)

func TestResourceExecuteSearchStreamsResponse(t *testing.T) {
	acceptEncoding := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		acceptEncoding <- req.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "999")
		w.Header().Set("Content-Encoding", "identity")
		w.Header().Set("Transfer-Encoding", "chunked")
		w.WriteHeader(http.StatusOK)

		flusher := w.(http.Flusher)
		_, _ = w.Write([]byte("{\"results\":[\"http_requests_total\"]}\n"))
		flusher.Flush()
		time.Sleep(10 * time.Millisecond)
		_, _ = w.Write([]byte("{\"status\":\"success\",\"has_more\":false}\n"))
		flusher.Flush()
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	var responses []*backend.CallResourceResponse
	err := res.ExecuteSearch(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names?limit=100",
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		responses = append(responses, resp)
		return nil
	}))

	require.NoError(t, err)
	require.Equal(t, "identity", <-acceptEncoding)
	require.GreaterOrEqual(t, len(responses), 3)
	require.Equal(t, http.StatusOK, responses[0].Status)
	require.Equal(t, "application/x-ndjson; charset=utf-8", http.Header(responses[0].Headers).Get("Content-Type"))
	require.Empty(t, http.Header(responses[0].Headers).Get("Content-Length"))
	require.Empty(t, http.Header(responses[0].Headers).Get("Content-Encoding"))
	require.Empty(t, http.Header(responses[0].Headers).Get("Transfer-Encoding"))

	var body strings.Builder
	for _, resp := range responses[1:] {
		body.Write(resp.Body)
	}
	require.Equal(t,
		"{\"results\":[\"http_requests_total\"]}\n{\"status\":\"success\",\"has_more\":false}\n",
		body.String(),
	)
}

func TestResourceExecuteSearchPassesThroughErrorResponse(t *testing.T) {
	errorBody := `{"status":"error","errorType":"unavailable","error":"search API disabled"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(errorBody))
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	var responses []*backend.CallResourceResponse
	err := res.ExecuteSearch(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names",
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		responses = append(responses, resp)
		return nil
	}))

	require.NoError(t, err)
	require.Len(t, responses, 1)
	require.Equal(t, http.StatusInternalServerError, responses[0].Status)
	require.Equal(t, errorBody, string(responses[0].Body))
	require.Equal(t, "application/json", http.Header(responses[0].Headers).Get("Content-Type"))
}

func TestResourceExecuteSearchStripsFramingHeadersFromErrorResponse(t *testing.T) {
	errorBody := `{"status":"error","error":"boom"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(errorBody))
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	var responses []*backend.CallResourceResponse
	err := res.ExecuteSearch(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names",
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		responses = append(responses, resp)
		return nil
	}))

	require.NoError(t, err)
	require.Len(t, responses, 1)
	require.Equal(t, http.StatusBadGateway, responses[0].Status)
	require.Equal(t, errorBody, string(responses[0].Body))
	require.Equal(t, "application/json", http.Header(responses[0].Headers).Get("Content-Type"))
	// Stale framing headers describe the upstream payload, not what we forward,
	// so a downstream proxy would reject the mismatch.
	require.Empty(t, http.Header(responses[0].Headers).Get("Content-Encoding"))
	require.Empty(t, http.Header(responses[0].Headers).Get("Content-Length"))
	require.Empty(t, http.Header(responses[0].Headers).Get("Transfer-Encoding"))
}

func TestResourceExecuteSearchLimitsErrorBodySize(t *testing.T) {
	oversized := strings.Repeat("x", resource.MaxSearchErrorBodyBytes+1024)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(oversized))
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	var responses []*backend.CallResourceResponse
	err := res.ExecuteSearch(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names",
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		responses = append(responses, resp)
		return nil
	}))

	require.NoError(t, err)
	require.Len(t, responses, 1)
	require.Equal(t, http.StatusInternalServerError, responses[0].Status)
	require.Len(t, responses[0].Body, resource.MaxSearchErrorBodyBytes)
}

func TestResourceExecuteSearchStopsOnCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{\"results\":[\"up\"]}\n"))
		w.(http.Flusher).Flush()
		<-req.Context().Done()
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err := res.ExecuteSearch(ctx, &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names",
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		if len(resp.Body) > 0 {
			cancel()
		}
		return nil
	}))

	require.ErrorIs(t, err, context.Canceled)
}

func TestResourceExecuteSearchReturnsSenderError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	res := newSearchResource(t, server.URL)
	senderErr := errors.New("send failed")
	err := res.ExecuteSearch(context.Background(), &backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "api/v1/search/metric_names",
		URL:    "/api/v1/search/metric_names",
	}, backend.CallResourceResponseSenderFunc(func(_ *backend.CallResourceResponse) error {
		return senderErr
	}))

	require.ErrorIs(t, err, senderErr)
}

func newSearchResource(t *testing.T, serverURL string) *resource.Resource {
	t.Helper()
	res, err := resource.New(http.DefaultClient, backend.DataSourceInstanceSettings{
		URL:      serverURL,
		JSONData: []byte(`{"httpMethod":"GET"}`),
	}, log.DefaultLogger)
	require.NoError(t, err)
	return res
}
