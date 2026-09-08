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

	t.Run("enables ForwardHTTPHeaders so Grafana headers (FromAlert, X-Rule-*, X-Dashboard-*, X-Panel-*, X-Grafana-*) are forwarded to the datasource", func(t *testing.T) {
		opts, err := CreateTransportOptions(context.Background(), backend.DataSourceInstanceSettings{}, backend.NewLoggerWith("logger", "test"))
		require.NoError(t, err)
		require.True(t, opts.ForwardHTTPHeaders)
	})

	// The SDK's CustomHeadersMiddleware deletes and re-adds every configured
	// header on the outgoing request, so a custom Accept-Encoding would replace
	// the gzip that QueryResource pins and the response would arrive in an
	// encoding the resource handlers cannot decode.
	t.Run("drops a custom Accept-Encoding header so it cannot override the pinned gzip", func(t *testing.T) {
		settings := backend.DataSourceInstanceSettings{
			JSONData: []byte(`{"httpHeaderName1": "Accept-Encoding", "httpHeaderName2": "X-Custom"}`),
			DecryptedSecureJSONData: map[string]string{
				"httpHeaderValue1": "zstd",
				"httpHeaderValue2": "keep-me",
			},
		}

		opts, err := CreateTransportOptions(context.Background(), settings, backend.NewLoggerWith("logger", "test"))

		require.NoError(t, err)
		require.Empty(t, opts.Header.Get("Accept-Encoding"))
		require.Equal(t, "keep-me", opts.Header.Get("X-Custom"), "other custom headers must still be applied")
	})
}
