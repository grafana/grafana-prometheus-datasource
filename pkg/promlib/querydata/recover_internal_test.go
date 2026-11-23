package querydata

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/tracing"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/intervalv2"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

type panickingCalculator struct{}

func (panickingCalculator) Calculate(backend.TimeRange, time.Duration, int64) intervalv2.Interval {
	panic("calculator exploded")
}

func (panickingCalculator) CalculateSafeInterval(backend.TimeRange, int64) intervalv2.Interval {
	panic("calculator exploded")
}

func TestExecuteTurnsAPanicBeforeTheRequestsIntoAQueryError(t *testing.T) {
	qd := &QueryData{intervalCalculator: panickingCalculator{}, tracer: tracing.DefaultTracer(), log: log.NewNullLogger()}
	b, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: "up", Range: true}})
	require.NoError(t, err)
	req := &backend.QueryDataRequest{
		Queries:       []backend.DataQuery{{RefID: "A", JSON: b, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)}}},
		PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
	}

	res, err := qd.Execute(context.Background(), req)
	require.NoError(t, err)
	failed := res.Responses["A"]
	require.ErrorContains(t, failed.Error, "panic triggered: calculator exploded")
	require.Equal(t, backend.ErrorSourcePlugin, failed.ErrorSource)
}
