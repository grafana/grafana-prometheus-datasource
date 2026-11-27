package datasource

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	sdkhttpclient "github.com/grafana/grafana-plugin-sdk-go/backend/httpclient"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
)

func replySizeRejections(t *testing.T) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	for _, f := range families {
		if f.GetName() == "grafana_prometheus_plugin_backend_reply_size_guard_rejected_count" {
			return f.GetMetric()[0].GetCounter().GetValue()
		}
	}
	return 0
}

func queryThreeSeries(t *testing.T, maxReplySize int64) backend.DataResponse {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"vector","result":[`+
			`{"metric":{"__name__":"up","job":"a"},"value":[1,"1"]},`+
			`{"metric":{"__name__":"up","job":"b"},"value":[1,"0"]},`+
			`{"metric":{"__name__":"up","job":"c"},"value":[1,"1"]}]}}`)
	}))
	t.Cleanup(srv.Close)

	d := &Datasource{Service: promlib.NewService(sdkhttpclient.NewProvider(), log.NewNullLogger(), nil), log: log.NewNullLogger(), maxReplySize: maxReplySize}
	resp, err := d.QueryData(context.Background(), &backend.QueryDataRequest{
		PluginContext: backend.PluginContext{
			DataSourceInstanceSettings: &backend.DataSourceInstanceSettings{UID: "prom", URL: srv.URL, JSONData: []byte("{}")},
			GrafanaConfig:              config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"}),
		},
		Queries: []backend.DataQuery{{RefID: "A", JSON: []byte(`{"expr":"up","instant":true}`), TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(600, 0)}}},
	})
	require.NoError(t, err)
	return resp.Responses["A"]
}

func TestQueryDataReplySizeGuard(t *testing.T) {
	tests := []struct {
		name         string
		maxReplySize int64
		rejected     bool
	}{
		{name: "fails a reply over the limit", maxReplySize: 64, rejected: true},
		{name: "keeps a reply under the limit", maxReplySize: querydata.MaxReplySize},
		{name: "keeps every reply when off", maxReplySize: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := replySizeRejections(t)
			res := queryThreeSeries(t, tt.maxReplySize)
			if tt.rejected {
				require.ErrorIs(t, res.Error, querydata.ErrReplyTooLarge)
				require.Equal(t, backend.ErrorSourceDownstream, res.ErrorSource)
				require.Empty(t, res.Frames)
				require.Equal(t, before+1, replySizeRejections(t))
				return
			}
			require.NoError(t, res.Error)
			require.Len(t, res.Frames, 3)
			require.Equal(t, before, replySizeRejections(t))
		})
	}
}

func TestNewDatasourceReadsTheReplySizeGuardSwitch(t *testing.T) {
	tests := []struct {
		value string
		want  int64
	}{
		{value: "", want: querydata.MaxReplySize},
		{value: "true", want: querydata.MaxReplySize},
		{value: "false", want: 0},
		{value: "0", want: 0},
	}
	for _, tt := range tests {
		t.Run("value="+tt.value, func(t *testing.T) {
			t.Setenv(replySizeGuardEnv, tt.value)
			inst, err := NewDatasource(context.Background(), backend.DataSourceInstanceSettings{})
			require.NoError(t, err)
			d, ok := inst.(*Datasource)
			require.True(t, ok)
			require.Equal(t, tt.want, d.maxReplySize)
		})
	}
}
