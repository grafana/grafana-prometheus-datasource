package middleware

import (
	"context"
	"net/http"
	"sync"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

const oauth2ClientCredentialsMiddlewareName = "prom-oauth2-client-credentials"

// OAuth2ClientCredentials returns a middleware that, when enabled in jsonData, fetches
// and caches an OAuth2 access token via the client-credentials grant and attaches it as
// an Authorization: Bearer header to outgoing Prometheus requests. Token fetch requests
// are made through "next" so they honor the datasource's own TLS/proxy configuration.
//
// The cached token is refreshed once its local expiry passes. If the authorization
// server invalidates a token earlier than that (revocation, secret rotation, clock
// skew, or a token response that omits an expiry altogether), the first request that
// comes back 401 forces a fresh token fetch and is retried once with the new token.
func OAuth2ClientCredentials(logger log.Logger, jsonData *models.PromOptions, clientSecret string) sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(oauth2ClientCredentialsMiddlewareName, func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		if jsonData == nil || !jsonData.OAuth2ClientCredentialsEnabled {
			return next
		}

		cfg := &clientcredentials.Config{
			ClientID:     jsonData.OAuth2ClientCredentialsID,
			ClientSecret: clientSecret,
			TokenURL:     jsonData.OAuth2ClientCredentialsTokenURL,
			Scopes:       jsonData.OAuth2ClientCredentialsScopes,
		}

		ctx := context.WithValue(context.Background(), oauth2.HTTPClient, &http.Client{Transport: next})

		return &oauth2RoundTripper{
			logger: logger,
			source: &reauthTokenSource{fetch: func() (*oauth2.Token, error) { return cfg.Token(ctx) }},
			base:   next,
		}
	})
}

// reauthTokenSource caches an OAuth2 token the way oauth2.ReuseTokenSource does, but
// additionally lets a caller force a fresh fetch that bypasses the cache, for use when
// the cached token turns out to no longer be accepted by the server.
type reauthTokenSource struct {
	fetch func() (*oauth2.Token, error)

	mu     sync.Mutex
	cached *oauth2.Token
}

func (s *reauthTokenSource) Token(forceRefresh bool) (*oauth2.Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !forceRefresh && s.cached.Valid() {
		return s.cached, nil
	}

	token, err := s.fetch()
	if err != nil {
		return nil, err
	}
	s.cached = token
	return token, nil
}

// oauth2RoundTripper attaches a Bearer token to outgoing requests. If the server
// responds 401, it forces a token refresh and retries the request once, since a 401
// on a locally-still-valid token usually means it was invalidated server-side.
type oauth2RoundTripper struct {
	logger log.Logger
	source *reauthTokenSource
	base   http.RoundTripper
}

func (t *oauth2RoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	reqBodyClosed := false
	if req.Body != nil {
		defer func() {
			if !reqBodyClosed {
				req.Body.Close()
			}
		}()
	}

	token, err := t.source.Token(false)
	if err != nil {
		return nil, err
	}

	req2 := req.Clone(req.Context())
	token.SetAuthHeader(req2)
	reqBodyClosed = true
	resp, err := t.base.RoundTrip(req2)
	if err != nil || resp.StatusCode != http.StatusUnauthorized {
		return resp, err
	}
	if req.Body != nil && req.GetBody == nil {
		// The original body was already consumed and can't be safely re-sent.
		return resp, nil
	}

	newToken, refreshErr := t.source.Token(true)
	if refreshErr != nil || newToken.AccessToken == token.AccessToken {
		return resp, nil
	}

	req3 := req.Clone(req.Context())
	if req.GetBody != nil {
		b, err := req.GetBody()
		if err != nil {
			return resp, nil
		}
		req3.Body = b
	}
	newToken.SetAuthHeader(req3)

	t.logger.Debug("Retrying Prometheus request after refreshing OAuth2 client credentials token", "previousStatus", resp.StatusCode)
	_ = resp.Body.Close()
	return t.base.RoundTrip(req3)
}
