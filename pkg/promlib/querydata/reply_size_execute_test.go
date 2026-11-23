package querydata_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	p "github.com/prometheus/common/model"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata"
)

func replyQuery(t *testing.T, refID string, props models.PrometheusQueryProperties) backend.DataQuery {
	t.Helper()
	b, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: props})
	require.NoError(t, err)
	return backend.DataQuery{RefID: refID, JSON: b, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(600, 0)}}
}

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

func randomVector(r *rand.Rand, series int) p.Vector {
	v := make(p.Vector, series)
	for i := range v {
		m := p.Metric{"__name__": "up", "pod": p.LabelValue(fmt.Sprintf("pod-%d", i))}
		for j := range r.Intn(8) {
			m[p.LabelName(fmt.Sprintf("l%d", j))] = p.LabelValue(strings.Repeat("v", r.Intn(30)) + []string{"", `"q`, "<&>", "\xff"}[r.Intn(4)])
		}
		v[i] = &p.Sample{Metric: m, Value: p.SampleValue(r.Float64()), Timestamp: 1000}
	}
	return v
}

func randomMatrix(r *rand.Rand, series int) p.Matrix {
	m := make(p.Matrix, series)
	for i := range m {
		values := make([]p.SamplePair, 1+r.Intn(40))
		for j := range values {
			values[j] = p.SamplePair{Timestamp: p.Time(1000 * (j + 1)), Value: p.SampleValue(r.Float64())}
		}
		m[i] = &p.SampleStream{Metric: p.Metric{"__name__": "up", "pod": p.LabelValue(fmt.Sprintf("pod-%d", i))}, Values: values}
	}
	return m
}

func executeReply(t *testing.T, guard bool, limit int64, rangeRes, instantRes any) *backend.QueryDataResponse {
	t.Helper()
	tctx, err := setup()
	require.NoError(t, err)
	querydata.SetReplySizeGuard(tctx.queryData, guard, limit)
	rr, err := toAPIResponse(rangeRes)
	require.NoError(t, err)
	ir, err := toAPIResponse(instantRes)
	require.NoError(t, err)
	tctx.httpProvider.setResponse(rr, ir, nil)
	req := &backend.QueryDataRequest{
		Queries: []backend.DataQuery{
			replyQuery(t, "range", models.PrometheusQueryProperties{Expr: "up", Range: true}),
			replyQuery(t, "instant", models.PrometheusQueryProperties{Expr: "up", Instant: true}),
		},
		PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
	}
	res, err := tctx.queryData.Execute(context.Background(), req)
	require.NoError(t, err)
	return res
}

func TestExecuteFailsEveryQueryOfAReplyOverTheSizeLimit(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	rangeRes := queryResult{Type: p.ValMatrix, Result: randomMatrix(r, 3)}
	instantRes := queryResult{Type: p.ValVector, Result: randomVector(r, 3)}

	before := replySizeRejections(t)
	res := executeReply(t, true, 64, rangeRes, instantRes)
	for _, refID := range []string{"range", "instant"} {
		require.ErrorIs(t, res.Responses[refID].Error, querydata.ErrReplyTooLarge)
		require.ErrorContains(t, res.Responses[refID].Error, "more than the 64-byte limit of a reply to Grafana")
		require.Equal(t, backend.ErrorSourceDownstream, res.Responses[refID].ErrorSource)
		require.Empty(t, res.Responses[refID].Frames)
	}
	require.Equal(t, before+1, replySizeRejections(t))

	off := executeReply(t, false, 64, rangeRes, instantRes)
	for _, refID := range []string{"range", "instant"} {
		require.NoError(t, off.Responses[refID].Error)
		require.NotEmpty(t, off.Responses[refID].Frames)
	}
}

func TestExecuteRepliesUnderTheSizeLimitAreTheSameWithTheGuardOff(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	for i := range 200 {
		rangeRes := queryResult{Type: p.ValMatrix, Result: randomMatrix(r, r.Intn(60))}
		instantRes := queryResult{Type: p.ValVector, Result: randomVector(r, r.Intn(60))}
		on, err := json.Marshal(executeReply(t, true, math.MaxInt32, rangeRes, instantRes))
		require.NoError(t, err)
		off, err := json.Marshal(executeReply(t, false, math.MaxInt32, rangeRes, instantRes))
		require.NoError(t, err)
		require.JSONEq(t, string(off), string(on), "case %d", i)
	}
}

func BenchmarkExecuteReplySizeGuard(b *testing.B) {
	r := rand.New(rand.NewSource(3))
	res, err := toAPIResponse(queryResult{Type: p.ValVector, Result: randomVector(r, 20_000)})
	require.NoError(b, err)
	raw, err := io.ReadAll(res.Body)
	require.NoError(b, err)
	b.Logf("instant body %d bytes", len(raw))
	for _, guard := range []bool{true, false} {
		b.Run(map[bool]string{true: "on", false: "off"}[guard], func(b *testing.B) {
			tctx, err := setup()
			require.NoError(b, err)
			querydata.SetReplySizeGuard(tctx.queryData, guard, math.MaxInt32)
			q, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: "up", Instant: true}})
			require.NoError(b, err)
			req := &backend.QueryDataRequest{
				Queries:       []backend.DataQuery{{RefID: "A", JSON: q, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(600, 0)}}},
				PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
			}
			b.ReportAllocs()
			for b.Loop() {
				tctx.httpProvider.setResponse(nil, &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(raw))}, nil)
				if _, err := tctx.queryData.Execute(context.Background(), req); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
