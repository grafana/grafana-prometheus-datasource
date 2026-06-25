package middleware

import (
	"net/http"
	"testing"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/stretchr/testify/require"
)

func TestForwardFromAlertHeader(t *testing.T) {
	finalRoundTripper := sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Request: req}, nil
	})

	newReq := func(t *testing.T) *http.Request {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, "http://localhost:9090", nil)
		require.NoError(t, err)
		return req
	}

	t.Run("sets the FromAlert header on the outgoing request", func(t *testing.T) {
		rt := ForwardFromAlertHeader("true").CreateMiddleware(sdkhttpclient.Options{}, finalRoundTripper)
		req := newReq(t)
		_, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.Equal(t, "true", req.Header.Get(FromAlertHeaderName))
	})

	t.Run("does not overwrite an existing FromAlert header", func(t *testing.T) {
		rt := ForwardFromAlertHeader("true").CreateMiddleware(sdkhttpclient.Options{}, finalRoundTripper)
		req := newReq(t)
		req.Header.Set(FromAlertHeaderName, "preset")
		_, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.Equal(t, "preset", req.Header.Get(FromAlertHeaderName))
	})

	t.Run("is a no-op for an empty value", func(t *testing.T) {
		rt := ForwardFromAlertHeader("").CreateMiddleware(sdkhttpclient.Options{}, finalRoundTripper)
		req := newReq(t)
		_, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.Empty(t, req.Header.Get(FromAlertHeaderName))
	})

	t.Run("exposes a stable middleware name", func(t *testing.T) {
		named, ok := ForwardFromAlertHeader("true").(sdkhttpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, forwardAlertHeadersMiddlewareName, named.MiddlewareName())
	})
}
