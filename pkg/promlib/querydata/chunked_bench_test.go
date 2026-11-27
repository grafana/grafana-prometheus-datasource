package querydata_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"runtime/debug"
	"runtime/metrics"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/grafana/grafana-plugin-sdk-go/genproto/pluginv2"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// promBody makes a Prometheus response with the given series. Each series has 10 labels. A vector has one sample
// per series.
func promBody(resultType string, series, points int) string {
	var b strings.Builder
	fmt.Fprintf(&b, `{"status":"success","data":{"resultType":%q,"result":[`, resultType)
	for s := range series {
		if s > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"metric":{"__name__":"http_requests_total","job":"api","instance":"10.0.%d.%d:9090"`, s/256, s%256)
		for l := range 7 {
			fmt.Fprintf(&b, `,"label_%d":"value_%d"`, l, (s+l)%10)
		}
		b.WriteString(`},`)
		if resultType == "vector" {
			fmt.Fprintf(&b, `"value":[1700000000,"%d"]}`, s)
			continue
		}
		b.WriteString(`"values":[`)
		for p := range points {
			if p > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `[%d,"%d"]`, 1700000000+p*15, p)
		}
		b.WriteString(`]}`)
	}
	b.WriteString(`]}}`)
	return b.String()
}

// peakHeap runs run once and returns the largest heap, above the heap before the run, that a sampler saw. The GC
// runs often during the run, so the peak is close to the live heap and does not depend on how much garbage the
// default GC percent allows.
func peakHeap(run func()) float64 {
	defer debug.SetGCPercent(debug.SetGCPercent(10))
	runtime.GC()
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	read := func() uint64 {
		metrics.Read(sample)
		return sample[0].Value.Uint64()
	}
	before := read()

	var peak atomic.Uint64
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(100 * time.Microsecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if v := read(); v > peak.Load() {
					peak.Store(v)
				}
			}
		}
	}()
	run()
	close(done)
	<-stopped

	if peak.Load() < before {
		return 0
	}
	return float64(peak.Load() - before)
}

// BenchmarkExecuteVsExecuteChunked compares Execute, with the Arrow encoding of its response that the SDK does for
// gRPC, and ExecuteChunked, with a writer that encodes each chunk and drops it. peak_heap_bytes is the heap that one
// run adds at its peak.
//
//	go test -run '^$' -bench BenchmarkExecuteVsExecuteChunked -benchmem -count 6 ./querydata/ | tee chunked.txt
//	benchstat -col /method chunked.txt
func BenchmarkExecuteVsExecuteChunked(b *testing.B) {
	queries := func(n int, props models.PrometheusQueryProperties) []backend.DataQuery {
		qs := make([]backend.DataQuery, n)
		for i := range qs {
			qs[i] = promQuery(b, fmt.Sprintf("Q%d", i), props)
		}
		return qs
	}
	instant := models.PrometheusQueryProperties{Expr: "http_requests_total", Instant: true}
	rangeQuery := models.PrometheusQueryProperties{Expr: "http_requests_total", Range: true}

	workloads := []struct {
		name    string
		path    string
		body    string
		queries []backend.DataQuery
	}{
		// The shape of grafana/grafana#133856: one panel with 8 instant queries of 25,000 series.
		{"instant-8x25000", "/api/v1/query", promBody("vector", 25000, 1), queries(8, instant)},
		{"range-1000x250", "/api/v1/query_range", promBody("matrix", 1000, 250), queries(1, rangeQuery)},
		{"range-4000x250", "/api/v1/query_range", promBody("matrix", 4000, 250), queries(1, rangeQuery)},
		// Prometheus returns at most 11,000 points per series.
		{"range-1x11000", "/api/v1/query_range", promBody("matrix", 1, 11000), queries(1, rangeQuery)},
	}

	grafanaCfg := config.NewGrafanaCfg(map[string]string{config.ConcurrentQueryCount: "10"})
	pluginCtx := backend.PluginContext{GrafanaConfig: grafanaCfg}
	ctx := config.WithGrafanaConfig(context.Background(), grafanaCfg)

	for _, wl := range workloads {
		tctx, err := setup()
		require.NoError(b, err)
		// One copy of the body for all requests, so that the peak heap does not count it.
		body := []byte(wl.body)
		tctx.httpProvider.roundTrip = func(req *http.Request) (*http.Response, error) {
			if req.URL.Path != wl.path {
				return nil, fmt.Errorf("no fixture for %s", req.URL.Path)
			}
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(bytes.NewReader(body))}, nil
		}

		execute := func() {
			rsp, err := tctx.queryData.Execute(ctx, &backend.QueryDataRequest{Queries: wl.queries, PluginContext: pluginCtx})
			require.NoError(b, err)
			_, err = backend.ToProto().QueryDataResponse(backend.DataFrameFormat_ARROW, rsp)
			require.NoError(b, err)
		}
		b.Run(wl.name+"/method=Execute", func(b *testing.B) {
			peak := peakHeap(execute)
			b.ReportAllocs()
			for b.Loop() {
				execute()
			}
			// After the loop, because b.Loop resets the reported metrics.
			b.ReportMetric(peak, "peak_heap_bytes")
		})

		for _, cf := range chunkFormats {
			executeChunked := func() {
				w := backend.NewChunkedDataWriter(cf.format, func(*pluginv2.QueryChunkedDataResponse) error { return nil })
				req := &backend.QueryChunkedDataRequest{Queries: wl.queries, PluginContext: pluginCtx, Format: cf.format}
				require.NoError(b, tctx.queryData.ExecuteChunked(ctx, req, w))
			}
			b.Run(wl.name+"/method=ExecuteChunked-"+cf.name, func(b *testing.B) {
				peak := peakHeap(executeChunked)
				b.ReportAllocs()
				for b.Loop() {
					executeChunked()
				}
				b.ReportMetric(peak, "peak_heap_bytes")
			})
		}
	}
}
