package querydata_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/converter"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
)

// mimirServer answers instant queries with a Mimir fixture, in protobuf when the request accepts it and in JSON
// otherwise, as Mimir's query-frontend does.
func mimirServer(t *testing.T, fixture string, protobufRequests *atomic.Int32) *httptest.Server {
	t.Helper()
	pb, err := os.ReadFile("../converter/testdata/mimir-protobuf/" + fixture + ".pb")
	require.NoError(t, err)
	js, err := os.ReadFile("../converter/testdata/mimir-protobuf/" + fixture + ".json")
	require.NoError(t, err)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.Header.Get("Accept"), converter.MimirProtobufMediaType) {
			protobufRequests.Add(1)
			w.Header().Set("Content-Type", converter.MimirProtobufMediaType)
			_, _ = w.Write(pb)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(js)
	}))
	t.Cleanup(server.Close)
	return server
}

func runInstantQuery(t *testing.T, url string, cfg map[string]string, opts ...client.Option) backend.DataResponse {
	t.Helper()
	qd, err := querydata.New(http.DefaultClient, backend.DataSourceInstanceSettings{URL: url}, http.MethodPost, "", "15s", log.NewNullLogger(), config.FeatureToggles{}, opts...)
	require.NoError(t, err)
	b, err := json.Marshal(&models.QueryModel{PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: "up", Instant: true}})
	require.NoError(t, err)
	grafanaCfg := config.NewGrafanaCfg(cfg)
	req := &backend.QueryDataRequest{
		Queries:       []backend.DataQuery{{RefID: "A", JSON: b}},
		PluginContext: backend.PluginContext{GrafanaConfig: grafanaCfg},
	}
	res, err := qd.Execute(config.WithGrafanaConfig(context.Background(), grafanaCfg), req)
	require.NoError(t, err)
	return res.Responses["A"]
}

func TestQueryDataMimirProtobufResponse(t *testing.T) {
	on := client.WithMimirProtobuf(func(context.Context) bool { return true })

	t.Run("decodes the protobuf response into the frames of the JSON response", func(t *testing.T) {
		var protobufRequests atomic.Int32
		server := mimirServer(t, "vector-floats-then-hist", &protobufRequests)

		jsonRsp := runInstantQuery(t, server.URL, nil)
		require.Zero(t, protobufRequests.Load())
		protobufRsp := runInstantQuery(t, server.URL, nil, on)
		require.Equal(t, int32(1), protobufRequests.Load())

		require.NoError(t, jsonRsp.Error)
		require.NoError(t, protobufRsp.Error)
		require.Len(t, protobufRsp.Frames, 3)
		for i := range jsonRsp.Frames {
			want, err := jsonRsp.Frames[i].MarshalArrow()
			require.NoError(t, err)
			got, err := protobufRsp.Frames[i].MarshalArrow()
			require.NoError(t, err)
			require.Equal(t, want, got, "frame %d", i)
		}
	})

	t.Run("applies the series limit", func(t *testing.T) {
		var protobufRequests atomic.Int32
		server := mimirServer(t, "vector-floats-then-hist", &protobufRequests)
		rsp := runInstantQuery(t, server.URL, map[string]string{"GF_SERIES_LIMIT": "2"}, on)
		require.Equal(t, int32(1), protobufRequests.Load())
		require.ErrorIs(t, rsp.Error, converter.ErrMaxSeriesExceeded)
	})

	t.Run("decodes a JSON error body when protobuf was accepted", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"status":"error","errorType":"execution","error":"query too large"}`))
		}))
		t.Cleanup(server.Close)
		rsp := runInstantQuery(t, server.URL, nil, on)
		require.EqualError(t, rsp.Error, "execution: query too large")
	})
}
