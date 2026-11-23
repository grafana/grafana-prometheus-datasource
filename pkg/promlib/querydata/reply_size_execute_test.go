package querydata_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"testing"
	"time"

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

func TestRejectOversizedReplyFailsEveryQueryOfAnExecuteReply(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	tctx, err := setup()
	require.NoError(t, err)
	rangeRes, err := toAPIResponse(queryResult{Type: p.ValMatrix, Result: randomMatrix(r, 3)})
	require.NoError(t, err)
	instantRes, err := toAPIResponse(queryResult{Type: p.ValVector, Result: randomVector(r, 3)})
	require.NoError(t, err)
	tctx.httpProvider.setResponse(rangeRes, instantRes, nil)
	req := &backend.QueryDataRequest{
		Queries: []backend.DataQuery{
			replyQuery(t, "range", models.PrometheusQueryProperties{Expr: "up", Range: true}),
			replyQuery(t, "instant", models.PrometheusQueryProperties{Expr: "up", Instant: true}),
		},
		PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
	}
	res, err := tctx.queryData.Execute(context.Background(), req)
	require.NoError(t, err)

	size, rejected := querydata.RejectOversizedReply(res, 64)
	require.True(t, rejected)
	require.Greater(t, size, int64(64))
	for _, refID := range []string{"range", "instant"} {
		require.ErrorIs(t, res.Responses[refID].Error, querydata.ErrReplyTooLarge)
		require.ErrorContains(t, res.Responses[refID].Error, "more than the 64-byte limit of a reply to Grafana")
		require.Equal(t, backend.ErrorSourceDownstream, res.Responses[refID].ErrorSource)
		require.Empty(t, res.Responses[refID].Frames)
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
			q, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: "up", Instant: true}})
			require.NoError(b, err)
			req := &backend.QueryDataRequest{
				Queries:       []backend.DataQuery{{RefID: "A", JSON: q, TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(600, 0)}}},
				PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})},
			}
			b.ReportAllocs()
			for b.Loop() {
				tctx.httpProvider.setResponse(nil, &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(raw))}, nil)
				res, err := tctx.queryData.Execute(context.Background(), req)
				if err != nil {
					b.Fatal(err)
				}
				if guard {
					querydata.RejectOversizedReply(res, querydata.MaxReplySize)
				}
			}
		})
	}
}
