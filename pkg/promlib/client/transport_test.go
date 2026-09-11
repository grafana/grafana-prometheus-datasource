package client

import (
	"context"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
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
		jsonData, err := models.ParsePromOptions(settings)
		require.NoError(t, err)
		opts, err := CreateTransportOptions(
			context.Background(),
			settings,
			jsonData.HTTPMethod,
			string(jsonData.CustomQueryParameters),
			float64(jsonData.MaxSamplesProcessedWarningThreshold),
			float64(jsonData.MaxSamplesProcessedErrorThreshold),
			bool(jsonData.QueryStatsEnabled),
			backend.NewLoggerWith("logger", "test"),
		)
		require.NoError(t, err)
		require.Equal(t, http.Header{"Foo": []string{"bar"}}, opts.Header)
		require.Equal(t, 1, len(opts.Middlewares))
	})

	t.Run("enables ForwardHTTPHeaders so Grafana headers (FromAlert, X-Rule-*, X-Dashboard-*, X-Panel-*, X-Grafana-*) are forwarded to the datasource", func(t *testing.T) {
		settings := backend.DataSourceInstanceSettings{}
		jsonData, err := models.ParsePromOptions(settings)
		require.NoError(t, err)
		opts, err := CreateTransportOptions(
			context.Background(),
			settings,
			jsonData.HTTPMethod,
			string(jsonData.CustomQueryParameters),
			float64(jsonData.MaxSamplesProcessedWarningThreshold),
			float64(jsonData.MaxSamplesProcessedErrorThreshold),
			bool(jsonData.QueryStatsEnabled),
			backend.NewLoggerWith("logger", "test"),
		)
		require.NoError(t, err)
		require.True(t, opts.ForwardHTTPHeaders)
	})
}
