package middleware

import (
	"net/http"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
)

// FromAlertHeaderName is the plain (non "http_"-prefixed) header the alerting
// engine sets on the QueryDataRequest. Because it is not "http_"-prefixed it is
// excluded from QueryDataRequest.GetHTTPHeaders(), so the SDK's generic header
// forwarding never propagates it. We forward it explicitly instead.
const FromAlertHeaderName = "FromAlert"

const forwardAlertHeadersMiddlewareName = "prom-forward-alert-headers"

// ForwardFromAlertHeader returns a contextual HTTP middleware that sets the
// FromAlert header (with the given value) on the outgoing upstream request.
//
// It is meant to be installed per-request via
// sdkhttpclient.WithContextualMiddleware when the QueryDataRequest originates
// from alerting, mirroring core Grafana's HTTPClientMiddleware which special-cases
// the same header. An existing FromAlert header is never overwritten.
func ForwardFromAlertHeader(value string) sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(forwardAlertHeadersMiddlewareName, func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		if value == "" {
			return next
		}
		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			if req.Header.Get(FromAlertHeaderName) == "" {
				req.Header.Set(FromAlertHeaderName, value)
			}
			return next.RoundTrip(req)
		})
	})
}
