//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/klauspost/compress/snappy"
	"github.com/prometheus/prometheus/prompb"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// benchShapes are prod-shaped results with 10 labels per series, as in the promlib converter benchmarks.
var benchShapes = []struct {
	name      string
	metric    string
	series    int
	points    int
	histogram bool
}{
	{name: "vector_25k_series", metric: "itb_vector", series: 25_000, points: 1},
	{name: "matrix_1k_series_240_points", metric: "itb_matrix", series: 1_000, points: 240},
	{name: "histograms_100_series_240_points", metric: "itb_hist", series: 100, points: 240, histogram: true},
}

// Each write stays under the default per-tenant ingestion burst of Mimir and Cortex, and under Cortex's 4 MiB
// message limit from distributor to ingester.
const (
	benchBatchSamples = 20_000
	benchBatchSeries  = 2_000
)

var (
	loadBenchOnce sync.Once
	errLoadBench  error
)

// BenchmarkQueryData runs promlib's Service against every backend with the Mimir protobuf flag off and on. Compare
// the flag with `benchstat -col /flag`.
func BenchmarkQueryData(b *testing.B) {
	loadBenchOnce.Do(func() { errLoadBench = loadBench(b) })
	if errLoadBench != nil {
		b.Fatal(errLoadBench)
	}
	for _, tgt := range targets {
		for _, shape := range benchShapes {
			model, err := json.Marshal(models.QueryModel{
				PrometheusQueryProperties: models.PrometheusQueryProperties{Expr: selector(shape.metric), Instant: shape.points == 1, Range: shape.points > 1},
				Interval:                  "15s",
			})
			if err != nil {
				b.Fatal(err)
			}
			for _, flagOn := range []bool{false, true} {
				b.Run(fmt.Sprintf("target=%s/shape=%s/flag=%s", tgt.name, shape.name, map[bool]string{false: "off", true: "on"}[flagOn]), func(b *testing.B) {
					s := newSession(b, tgt, flagOn)
					req := &backend.QueryDataRequest{PluginContext: s.pCtx, Queries: []backend.DataQuery{{
						RefID: "A", JSON: model, MaxDataPoints: int64(shape.points), Interval: step,
						TimeRange: backend.TimeRange{From: anchor.Add(-time.Duration(shape.points-1) * step), To: anchor},
					}}}
					res, err := s.svc.QueryData(s.ctx, req)
					if err != nil {
						b.Fatal(err)
					}
					if rsp := res.Responses["A"]; rsp.Error != nil || len(rsp.Frames) != shape.series {
						b.Fatalf("QueryData returned %d frames and error %v, want %d frames", len(rsp.Frames), rsp.Error, shape.series)
					}
					b.ReportAllocs()
					for b.Loop() {
						if _, err := s.svc.QueryData(s.ctx, req); err != nil {
							b.Fatal(err)
						}
					}
				})
			}
		}
	}
}

func loadBench(b *testing.B) error {
	bodies, err := benchWriteRequests()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeoutCause(b.Context(), 5*time.Minute, errors.New("benchmark data not loaded within 5m"))
	defer cancel()
	for _, tgt := range targets {
		for _, body := range bodies {
			if err := retry(ctx, func() error { return write(ctx, tgt.writeURL, body) }); err != nil {
				return fmt.Errorf("write to %s: %w", tgt.name, err)
			}
		}
		for _, shape := range benchShapes {
			if err := retry(ctx, func() error { return countIs(ctx, tgt.queryURL, shape.metric, shape.series) }); err != nil {
				return fmt.Errorf("read from %s: %w", tgt.name, err)
			}
		}
	}
	return nil
}

func benchWriteRequests() ([][]byte, error) {
	var bodies [][]byte
	var req prompb.WriteRequest
	samples := 0
	flush := func() error {
		if len(req.Timeseries) == 0 {
			return nil
		}
		b, err := req.Marshal()
		if err != nil {
			return fmt.Errorf("marshal write request: %w", err)
		}
		bodies = append(bodies, snappy.Encode(nil, b))
		req, samples = prompb.WriteRequest{}, 0
		return nil
	}
	for _, shape := range benchShapes {
		for i := range shape.series {
			ts := prompb.TimeSeries{Labels: []prompb.Label{{Name: "__name__", Value: shape.metric}, {Name: "run", Value: run}, {Name: "series", Value: strconv.Itoa(i)}}}
			for j := 1; j <= 7; j++ {
				ts.Labels = append(ts.Labels, prompb.Label{Name: fmt.Sprintf("label_%02d", j), Value: fmt.Sprintf("value-%d-%d", j, i%(j*7+1))})
			}
			// Remote write requires labels sorted by name, and Thanos rejects them otherwise.
			slices.SortFunc(ts.Labels, func(a, b prompb.Label) int { return strings.Compare(a.Name, b.Name) })
			for p := range shape.points {
				at := anchor.Add(time.Duration(p-shape.points+1) * step).UnixMilli()
				if shape.histogram {
					ts.Histograms = append(ts.Histograms, prompb.FromIntHistogram(at, histogramAt(uint64(i+p+1))))
				} else {
					// Rate-like values with full float64 precision.
					ts.Samples = append(ts.Samples, prompb.Sample{Timestamp: at, Value: float64(i*shape.points+p) / 7})
				}
			}
			if samples+shape.points > benchBatchSamples || len(req.Timeseries) == benchBatchSeries {
				if err := flush(); err != nil {
					return nil, err
				}
			}
			req.Timeseries = append(req.Timeseries, ts)
			samples += shape.points
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return bodies, nil
}

func countIs(ctx context.Context, queryURL, metric string, want int) error {
	q := url.Values{"query": {fmt.Sprintf("count(%s)", selector(metric))}, "time": {strconv.FormatInt(anchor.Unix(), 10)}}
	return queryCount(ctx, queryURL, q, want)
}
