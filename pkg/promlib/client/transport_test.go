package client

import (
	"context"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"
)

func TestCreateTransportOptions(t *testing.T) {
	t.Run("creates correct options object", func(t *testing.T) {
		settings := backend.DataSourceInstanceSettings{
			BasicAuthEnabled: false,
			BasicAuthUser:    "",
			JSONData:         []byte(`{"httpHeaderName1": "foo"}`),
			DecryptedSecureJSONData: map[string]string{
				"httpHeaderValue1": "bar",
			},
		}
		opts, err := CreateTransportOptions(context.Background(), settings, backend.NewLoggerWith("logger", "test"))
		require.NoError(t, err)
		require.Equal(t, http.Header{"Foo": []string{"bar"}}, opts.Header)
		require.Equal(t, 1, len(opts.Middlewares))
	})

	// Reproduces the externalization regression: when the plugin runs as an external
	// (out-of-process) backend, the core Grafana HTTPClientMiddleware that forwards
	// alerting headers (FromAlert, X-Rule-*) to the upstream is NOT present, because
	// it lives in the parent Grafana process and does not cross the gRPC boundary.
	//
	// The plugin-side equivalent only kicks in when the HTTP client opts in via
	// ForwardHTTPHeaders. Loki does this (grafana/grafana#90890); Prometheus does not,
	// which is why flipping Prometheus to external dropped the headers upstream.
	t.Run("enables ForwardHTTPHeaders so alert headers reach the upstream when externalized", func(t *testing.T) {
		settings := backend.DataSourceInstanceSettings{
			URL:      "http://localhost:9090",
			JSONData: []byte(`{}`),
		}
		opts, err := CreateTransportOptions(context.Background(), settings, backend.NewLoggerWith("logger", "test"))
		require.NoError(t, err)
		require.True(t, opts.ForwardHTTPHeaders, "ForwardHTTPHeaders must be true so the SDK forwards alert headers to the upstream Prometheus (parity with Loki / grafana#90890)")
	})
}
