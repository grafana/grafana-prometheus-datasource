package middleware

import (
	"context"
	"net/http"
	"testing"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/stretchr/testify/require"
)

// runForwarded drives ForwardGrafanaHeaders through the SDK's contextual
// middleware machinery (the same mechanism the httpclient provider uses) and
// returns the headers observed on the outgoing request.
func runForwarded(t *testing.T, inbound http.Header, seed func(*http.Request)) http.Header {
	t.Helper()

	var captured http.Header
	finalRT := sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
		captured = req.Header.Clone()
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Header: make(http.Header)}, nil
	})

	rt := sdkhttpclient.ContextualMiddleware().CreateMiddleware(sdkhttpclient.Options{}, finalRT)

	ctx := ForwardGrafanaHeaders(context.Background(), inbound)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://upstream/api/v1/rules", nil)
	require.NoError(t, err)
	if seed != nil {
		seed(req)
	}

	resp, err := rt.RoundTrip(req)
	require.NoError(t, err)
	require.NoError(t, resp.Body.Close())

	return captured
}

func TestForwardGrafanaHeaders_ForwardsAllowlistedHeaders(t *testing.T) {
	inbound := http.Header{
		"X-Datasource-Uid":    []string{"ds-1"},
		"X-Dashboard-Uid":     []string{"dash-123"},
		"X-Panel-Id":          []string{"7"},
		"X-Grafana-Org-Id":    []string{"42"},
		"X-Grafana-From-Expr": []string{"true"},
		"X-Rule-Uid":          []string{"rule-abc"},
		"X-Rule-Name":         []string{"HighErrorRate"},
	}

	got := runForwarded(t, inbound, nil)

	require.Equal(t, "ds-1", got.Get("X-Datasource-Uid"))
	require.Equal(t, "dash-123", got.Get("X-Dashboard-Uid"))
	require.Equal(t, "7", got.Get("X-Panel-Id"))
	require.Equal(t, "42", got.Get("X-Grafana-Org-Id"))
	require.Equal(t, "true", got.Get("X-Grafana-From-Expr"))
	require.Equal(t, "rule-abc", got.Get("X-Rule-Uid"))
	require.Equal(t, "HighErrorRate", got.Get("X-Rule-Name"))
}

func TestForwardGrafanaHeaders_DoesNotForwardAuthOrCookieHeaders(t *testing.T) {
	inbound := http.Header{
		"Authorization":   []string{"Bearer token"},
		"X-Id-Token":      []string{"id-token"},
		"X-Grafana-Id":    []string{"grafana-id"},
		"Cookie":          []string{"grafana_session=xyz"},
		"X-Dashboard-Uid": []string{"dash-123"},
	}

	got := runForwarded(t, inbound, nil)

	require.Empty(t, got.Get("Authorization"), "Authorization must not be forwarded")
	require.Empty(t, got.Get("X-Id-Token"), "X-Id-Token must not be forwarded")
	require.Empty(t, got.Get("X-Grafana-Id"), "X-Grafana-Id must not be forwarded")
	require.Empty(t, got.Get("Cookie"), "Cookie must not be forwarded")
	require.Equal(t, "dash-123", got.Get("X-Dashboard-Uid"))
}

func TestForwardGrafanaHeaders_DoesNotForwardAcceptEncoding(t *testing.T) {
	inbound := http.Header{
		"Accept-Encoding": []string{"gzip"},
		"X-Dashboard-Uid": []string{"dash-123"},
	}

	got := runForwarded(t, inbound, nil)

	require.Empty(t, got.Get("Accept-Encoding"), "Accept-Encoding must never be forwarded upstream")
	require.Equal(t, "dash-123", got.Get("X-Dashboard-Uid"))
}

func TestForwardGrafanaHeaders_DoesNotForwardNonAllowlistedHeaders(t *testing.T) {
	inbound := http.Header{
		"X-Custom-Secret": []string{"should-not-leak"},
	}

	got := runForwarded(t, inbound, nil)

	require.Empty(t, got.Get("X-Custom-Secret"), "headers outside the allowlist must not be forwarded")
}

func TestForwardGrafanaHeaders_DoesNotOverwriteExistingValue(t *testing.T) {
	inbound := http.Header{
		"X-Dashboard-Uid": []string{"inbound-dash"},
	}

	got := runForwarded(t, inbound, func(req *http.Request) {
		req.Header.Set("X-Dashboard-Uid", "preexisting-dash")
	})

	require.Equal(t, "preexisting-dash", got.Get("X-Dashboard-Uid"), "must not overwrite a value already set on the outgoing request")
}
