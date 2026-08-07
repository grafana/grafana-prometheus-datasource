package middleware

import (
	"context"
	"net/http"

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

		return &oauth2.Transport{
			Source: cfg.TokenSource(ctx),
			Base:   next,
		}
	})
}
