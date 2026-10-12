// Package hostlimit caps concurrent outgoing HTTP requests per destination host across every datasource instance in the process.
package hostlimit

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// EnvVar sets the per-host limit. Grafana sets it from max_concurrent_requests_per_host in the [plugin.prometheus] section.
const EnvVar = "GF_PLUGIN_MAX_CONCURRENT_REQUESTS_PER_HOST"

const middlewareName = "host-request-limit"

// ErrLimitReached is returned for a request whose destination host already has the maximum number of requests in flight.
var ErrLimitReached = errors.New("too many concurrent requests to host")

var rejections = promauto.NewCounter(prometheus.CounterOpts{
	Namespace: "grafana",
	Name:      "prometheus_plugin_host_request_limit_rejections_total",
	Help:      "The total number of outgoing requests rejected because their destination host had too many requests in flight",
})

// Limiter limits the number of in-flight requests per destination host.
type Limiter struct {
	limit int

	mu       sync.Mutex
	inFlight map[string]int
}

// New returns a Limiter that allows at most limit in-flight requests per host. A limit of zero or less disables it.
func New(limit int) *Limiter {
	return &Limiter{limit: limit, inFlight: map[string]int{}}
}

// FromEnv returns a Limiter configured from EnvVar. An unset or empty variable disables the limit, and so does an invalid value, which is also returned as an error.
func FromEnv() (*Limiter, error) {
	value := os.Getenv(EnvVar)
	if value == "" {
		return New(0), nil
	}
	n, err := strconv.Atoi(value)
	if err != nil {
		return New(0), fmt.Errorf("parse %s: %w", EnvVar, err)
	}
	if n < 0 {
		return New(0), fmt.Errorf("parse %s: %d is negative", EnvVar, n)
	}
	return New(n), nil
}

// Limit returns the maximum number of in-flight requests per host, or zero when the limit is disabled.
func (l *Limiter) Limit() int {
	return max(l.limit, 0)
}

// Middleware returns an HTTP client middleware that rejects a request at once, with a downstream ErrLimitReached, when its host is at the limit.
func (l *Limiter) Middleware() sdkhttpclient.Middleware {
	return sdkhttpclient.NamedMiddlewareFunc(middlewareName, func(opts sdkhttpclient.Options, next http.RoundTripper) http.RoundTripper {
		if l.limit <= 0 {
			return next
		}
		route := proxyRoute(opts)
		return sdkhttpclient.RoundTripperFunc(func(req *http.Request) (*http.Response, error) {
			host := hostKey(req.URL)
			key := route + host
			if !l.acquire(key) {
				if req.Body != nil {
					_ = req.Body.Close()
				}
				rejections.Inc()
				return nil, backend.DownstreamError(fmt.Errorf("%w %s", ErrLimitReached, host))
			}
			defer l.release(key)
			return next.RoundTrip(req)
		})
	})
}

func (l *Limiter) acquire(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.inFlight[key] >= l.limit {
		return false
	}
	l.inFlight[key]++
	return true
}

func (l *Limiter) release(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.inFlight[key]--
	if l.inFlight[key] <= 0 {
		delete(l.inFlight, key)
	}
}

// Proxied datasources resolve hosts inside their own private network, so the same host name can be a different backend.
func proxyRoute(opts sdkhttpclient.Options) string {
	if opts.ProxyOptions == nil || !opts.ProxyOptions.Enabled {
		return ""
	}
	user := ""
	if opts.ProxyOptions.Auth != nil {
		user = opts.ProxyOptions.Auth.Username
	}
	return "proxy/" + user + "/"
}

func hostKey(u *url.URL) string {
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http":
			port = "80"
		}
	}
	return net.JoinHostPort(strings.ToLower(u.Hostname()), port)
}
