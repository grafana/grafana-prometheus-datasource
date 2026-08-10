package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

func TestOAuth2ClientCredentialsMiddleware(t *testing.T) {
	logger := backend.NewLoggerWith("logger", "test")

	t.Run("Name should be correct", func(t *testing.T) {
		mw := OAuth2ClientCredentials(logger, &models.PromOptions{OAuth2ClientCredentialsEnabled: true}, "secret")
		middlewareName, ok := mw.(httpclient.MiddlewareName)
		require.True(t, ok)
		require.Equal(t, oauth2ClientCredentialsMiddlewareName, middlewareName.MiddlewareName())
	})

	t.Run("With nil jsonData should not apply middleware", func(t *testing.T) {
		finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			require.Empty(t, req.Header.Get("Authorization"))
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
		})
		mw := OAuth2ClientCredentials(logger, nil, "secret")
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://example.com", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
	})

	t.Run("With OAuth2ClientCredentialsEnabled=false should not apply middleware", func(t *testing.T) {
		finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			require.Empty(t, req.Header.Get("Authorization"))
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
		})
		mw := OAuth2ClientCredentials(logger, &models.PromOptions{OAuth2ClientCredentialsEnabled: false}, "secret")
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://example.com", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
	})

	t.Run("When enabled fetches a token and attaches it as a Bearer Authorization header", func(t *testing.T) {
		tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			require.Equal(t, "/oauth2/token", r.URL.Path)
			w.Header().Set("Content-Type", "application/json")
			_, err := w.Write([]byte(`{"access_token":"test-access-token","token_type":"Bearer","expires_in":3600}`))
			require.NoError(t, err)
		}))
		defer tokenServer.Close()

		var gotAuthHeader string
		finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/oauth2/token" {
				return http.DefaultTransport.RoundTrip(req)
			}
			gotAuthHeader = req.Header.Get("Authorization")
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
		})

		jsonData := &models.PromOptions{
			OAuth2ClientCredentialsEnabled:  true,
			OAuth2ClientCredentialsID:       "test-client-id",
			OAuth2ClientCredentialsTokenURL: tokenServer.URL + "/oauth2/token",
			OAuth2ClientCredentialsScopes:   []string{"read", "write"},
		}
		mw := OAuth2ClientCredentials(logger, jsonData, "test-client-secret")
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)
		require.NotNil(t, rt)

		req, err := http.NewRequest(http.MethodGet, "http://prometheus.example.com/api/v1/query", nil)
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		require.Equal(t, "Bearer test-access-token", gotAuthHeader)
	})

	t.Run("When a cached token is invalidated server-side, refreshes and retries once on 401", func(t *testing.T) {
		var tokenCount int32
		tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			n := atomic.AddInt32(&tokenCount, 1)
			w.Header().Set("Content-Type", "application/json")
			// expires_in is large so the local cache would never naturally expire; the
			// server-side invalidation is only discoverable via a 401 response.
			_, err := w.Write([]byte(`{"access_token":"token-` + string(rune('0'+n)) + `","token_type":"Bearer","expires_in":3600}`))
			require.NoError(t, err)
		}))
		defer tokenServer.Close()

		var gotAuthHeaders []string
		finalRoundTripper := httpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.Path == "/oauth2/token" {
				return http.DefaultTransport.RoundTrip(req)
			}
			auth := req.Header.Get("Authorization")
			gotAuthHeaders = append(gotAuthHeaders, auth)
			if auth == "Bearer token-1" {
				return &http.Response{StatusCode: http.StatusUnauthorized, Body: http.NoBody}, nil
			}
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
		})

		jsonData := &models.PromOptions{
			OAuth2ClientCredentialsEnabled:  true,
			OAuth2ClientCredentialsID:       "test-client-id",
			OAuth2ClientCredentialsTokenURL: tokenServer.URL + "/oauth2/token",
		}
		mw := OAuth2ClientCredentials(logger, jsonData, "test-client-secret")
		rt := mw.CreateMiddleware(httpclient.Options{}, finalRoundTripper)

		req, err := http.NewRequest(http.MethodPost, "http://prometheus.example.com/api/v1/query", strings.NewReader("query=up"))
		require.NoError(t, err)
		res, err := rt.RoundTrip(req)
		require.NoError(t, err)
		require.NotNil(t, res)
		require.Equal(t, http.StatusOK, res.StatusCode)
		require.Equal(t, []string{"Bearer token-1", "Bearer token-2"}, gotAuthHeaders)
		require.EqualValues(t, 2, atomic.LoadInt32(&tokenCount))

		// A subsequent request should reuse the refreshed token without another 401 round-trip.
		req2, err := http.NewRequest(http.MethodGet, "http://prometheus.example.com/api/v1/query", nil)
		require.NoError(t, err)
		res2, err := rt.RoundTrip(req2)
		require.NoError(t, err)
		require.Equal(t, http.StatusOK, res2.StatusCode)
		require.EqualValues(t, 2, atomic.LoadInt32(&tokenCount))
	})
}
