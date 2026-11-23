package querydata_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	p "github.com/prometheus/common/model"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

type panickingBody struct{}

func (panickingBody) Read([]byte) (int, error) { panic("malformed response") }
func (panickingBody) Close() error             { return nil }

func TestExecuteTurnsAPanicIntoAQueryError(t *testing.T) {
	panicking := func() *http.Response { return &http.Response{StatusCode: http.StatusOK, Body: panickingBody{}} }
	vector := func() *http.Response {
		res, err := toAPIResponse(queryResult{Type: p.ValVector, Result: p.Vector{{Metric: p.Metric{"app": "a"}, Value: 1, Timestamp: 1000}}})
		require.NoError(t, err)
		return res
	}
	matrix := func() *http.Response {
		res, err := toAPIResponse(queryResult{Type: p.ValMatrix, Result: p.Matrix{{Metric: p.Metric{"app": "a"}, Values: []p.SamplePair{{Value: 1, Timestamp: 1000}}}}})
		require.NoError(t, err)
		return res
	}
	query := func(refID string, props models.PrometheusQueryProperties) backend.DataQuery {
		b, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: props})
		require.NoError(t, err)
		return backend.DataQuery{RefID: refID, JSON: b, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)}}
	}

	tests := []struct {
		name                 string
		rangeRes, instantRes *http.Response
		failing, healthy     backend.DataQuery
	}{
		{
			name:     "range request",
			rangeRes: panicking(), instantRes: vector(),
			failing: query("range", models.PrometheusQueryProperties{Expr: "up", Range: true}),
			healthy: query("instant", models.PrometheusQueryProperties{Expr: "up", Instant: true}),
		},
		{
			name:     "instant request",
			rangeRes: matrix(), instantRes: panicking(),
			failing: query("instant", models.PrometheusQueryProperties{Expr: "up", Instant: true}),
			healthy: query("range", models.PrometheusQueryProperties{Expr: "up", Range: true}),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tctx, err := setup()
			require.NoError(t, err)
			tctx.httpProvider.setResponse(tt.rangeRes, tt.instantRes, nil)
			req := &backend.QueryDataRequest{
				Queries:       []backend.DataQuery{tt.failing, tt.healthy},
				PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
			}

			panicsBefore := queryPanicCount(t)
			res, err := tctx.queryData.Execute(context.Background(), req)
			require.NoError(t, err)
			failed := res.Responses[tt.failing.RefID]
			require.ErrorContains(t, failed.Error, "panic triggered: malformed response")
			require.Equal(t, backend.StatusInternal, failed.Status)
			require.Equal(t, backend.ErrorSourcePlugin, failed.ErrorSource)
			require.NoError(t, res.Responses[tt.healthy.RefID].Error, "a panic in one query does not fail the others")
			require.Len(t, res.Responses[tt.healthy.RefID].Frames, 1)
			require.Equal(t, panicsBefore+1, queryPanicCount(t))
		})
	}
}

func TestExecuteKeepsTheRangeResultWhenTheExemplarRequestPanics(t *testing.T) {
	tctx, err := setup()
	require.NoError(t, err)
	rangeRes, err := toAPIResponse(queryResult{Type: p.ValMatrix, Result: p.Matrix{{Metric: p.Metric{"app": "a"}, Values: []p.SamplePair{{Value: 1, Timestamp: 1000}}}}})
	require.NoError(t, err)
	tctx.httpProvider.setResponse(rangeRes, nil, &http.Response{StatusCode: http.StatusOK, Body: panickingBody{}})
	b, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: "up", Range: true, Exemplar: true}})
	require.NoError(t, err)
	req := &backend.QueryDataRequest{
		Queries:       []backend.DataQuery{{RefID: "A", JSON: b, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)}}},
		PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
	}

	panicsBefore := queryPanicCount(t)
	res, err := tctx.queryData.Execute(context.Background(), req)
	require.NoError(t, err)
	require.NoError(t, res.Responses["A"].Error)
	require.Len(t, res.Responses["A"].Frames, 1)
	require.Equal(t, panicsBefore+1, queryPanicCount(t))
}

func queryPanicCount(t *testing.T) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	require.NoError(t, err)
	for _, f := range families {
		if f.GetName() == "grafana_prometheus_plugin_backend_query_panic_count" {
			return f.GetMetric()[0].GetCounter().GetValue()
		}
	}
	t.Fatal("the query panic counter is not registered")
	return 0
}
