package middleware

import (
	"context"
	"net/http"

	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
)

const forwardGrafanaHeadersMiddlewareName = "prom-forward-grafana-headers"

// grafanaHeaderAllowlist is the set of Grafana-provided request headers that are
// safe to forward from an inbound plugin request (QueryData/CallResource/CheckHealth)
// to the outgoing datasource request.
//
// Encoding and hop-by-hop headers (notably Accept-Encoding) are intentionally
// excluded: forwarding Accept-Encoding makes Go's transport skip transparent
// decompression, which previously led to a response advertising Content-Encoding
// over an already-decoded body. FromAlert is also excluded here because the SDK's
// default NewAlertForwarderMiddleware already forwards it.
//
// Keys must be in canonical MIME header form (http.CanonicalHeaderKey), which is
// what http.Header lookups use internally.
var grafanaHeaderAllowlist = []string{
	// Tracing / dashboard-panel context.
	"X-Datasource-Uid",
	"X-Dashboard-Uid",
	"X-Panel-Id",
	"X-Dashboard-Title",
	"X-Panel-Title",
	"X-Panel-Plugin-Id",
	"X-Query-Group-Id",
	"X-Grafana-From-Expr",
	"X-Grafana-Caller-Id",
	"X-Grafana-Org-Id",

	// Alert rule context.
	"X-Rule-Name",
	"X-Rule-Uid",
	"X-Rule-Folder",
	"X-Rule-Source",
	"X-Rule-Type",
	"X-Rule-Version",
	"X-Rule-Origin",
}

// ForwardGrafanaHeaders registers a contextual httpclient middleware that copies
// the allowlisted Grafana headers from the inbound request onto the outgoing
// datasource request. It returns a context carrying that middleware, which the
// SDK httpclient provider applies when the prom client builds its request with
// the same context.
//
// A header is only set when it is present in the inbound headers and not already
// set on the outgoing request, so values established earlier in the chain are
// preserved.
func ForwardGrafanaHeaders(ctx context.Context, headers http.Header) context.Context {
	if len(headers) == 0 {
		return ctx
	}

	forward := make(http.Header, len(grafanaHeaderAllowlist))
	for _, key := range grafanaHeaderAllowlist {
		if v := headers.Get(key); v != "" {
			forward.Set(key, v)
		}
	}

	if len(forward) == 0 {
		return ctx
	}

	return sdkhttpclient.WithContextualMiddleware(ctx,
		sdkhttpclient.NamedMiddlewareFunc(forwardGrafanaHeadersMiddlewareName, func(_ sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
			return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
				for key, values := range forward {
					if req.Header.Get(key) == "" {
						req.Header.Set(key, values[0])
					}
				}
				return next.RoundTrip(req)
			})
		}))
}
