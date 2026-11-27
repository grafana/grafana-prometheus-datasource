package datasource

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/datasourcetest"
	"github.com/stretchr/testify/require"
)

// TestQueryChunkedDataMatchesQueryData runs both methods through the plugin's gRPC server, with the SDK middleware,
// against a fake Prometheus.
func TestQueryChunkedDataMatchesQueryData(t *testing.T) {
	matrix, err := os.ReadFile("../promlib/converter/testdata/prom-matrix.json")
	require.NoError(t, err)

	var mu sync.Mutex
	var authorization []string
	prom := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authorization = append(authorization, r.Header.Get("Authorization"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(matrix)
	}))
	t.Cleanup(prom.Close)

	plugin, err := datasourcetest.Manage(NewDatasource, datasourcetest.ManageOpts{Address: freeAddress(t)})
	require.NoError(t, err)
	t.Cleanup(func() { _ = plugin.Shutdown() })

	pluginCtx := backend.PluginContext{DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{
		UID:      "prometheus",
		URL:      prom.URL,
		JSONData: json.RawMessage(`{"oauthPassThru":true}`),
	}}
	queries := []backend.DataQuery{{
		RefID:     "A",
		JSON:      []byte(`{"expr":"up","range":true}`),
		Interval:  15 * time.Second,
		TimeRange: backend.TimeRange{From: time.Unix(1435781430, 0), To: time.Unix(1435781460, 0)},
	}}
	const token = "Bearer test-token"

	unaryReq := &backend.QueryDataRequest{PluginContext: pluginCtx, Queries: queries}
	unaryReq.SetHTTPHeader(backend.OAuthIdentityTokenHeaderName, token)
	unary, err := plugin.Client.QueryData(context.Background(), unaryReq)
	require.NoError(t, err)

	for _, format := range []backend.DataFrameFormat{backend.DataFrameFormat_ARROW, backend.DataFrameFormat_JSON} {
		chunkedReq := &backend.QueryChunkedDataRequest{PluginContext: pluginCtx, Queries: queries, Format: format}
		chunkedReq.SetHTTPHeader(backend.OAuthIdentityTokenHeaderName, token)
		chunked, err := plugin.Client.QueryChunkedData(context.Background(), chunkedReq)
		require.NoError(t, err)

		expected := unary.Responses["A"]
		actual := chunked.Responses["A"]
		require.NoError(t, expected.Error)
		require.NoError(t, actual.Error)
		require.Len(t, actual.Frames, len(expected.Frames))
		e, err := json.Marshal(expected.Frames)
		require.NoError(t, err)
		a, err := json.Marshal(actual.Frames)
		require.NoError(t, err)
		require.JSONEq(t, string(e), string(a))
	}

	mu.Lock()
	defer mu.Unlock()
	require.Equal(t, []string{token, token, token}, authorization, "both methods forward the OAuth token")
}

func freeAddress(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())
	return addr
}
