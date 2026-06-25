package middleware

import (
	"context"
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
// It is meant to be installed per-request via WithFromAlertForwarding when the
// request originates from alerting, mirroring core Grafana's HTTPClientMiddleware
// which special-cases the same header with an unconditional Set.
func ForwardFromAlertHeader(value string) sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(forwardAlertHeadersMiddlewareName, func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		if value == "" {
			return next
		}
		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			req.Header.Set(FromAlertHeaderName, value)
			return next.RoundTrip(req)
		})
	})
}

// WithFromAlertForwarding installs the FromAlert forwarding middleware on ctx when
// value is non-empty. It is a no-op for an empty value, so callers can pass the
// raw header value without guarding. FromAlert is forwarded ungated (independent
// of opts.ForwardHTTPHeaders), matching core Grafana's in-process behavior; it is
// a non-credential flag, so it carries no extra exposure.
func WithFromAlertForwarding(ctx context.Context, value string) context.Context {
	if value == "" {
		return ctx
	}
	return sdkhttpclient.WithContextualMiddleware(ctx, ForwardFromAlertHeader(value))
}
