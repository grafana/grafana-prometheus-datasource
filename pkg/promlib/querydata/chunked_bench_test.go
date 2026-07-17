package querydata

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/tracing"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/genproto/pluginv2"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/experiments/queryresponsejson"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata/exemplar"
)

// BenchmarkResponseConversion compares buffered and chunked matrix conversion.
//
// Run from pkg/promlib with a generated Prometheus matrix fixture:
//
//	PROM_CHUNKED_FIXTURE="${TMPDIR:-/tmp}/prom-query-json-bench/query-range-many-64m.json" \
//	  go test -benchmem -run=^$ -bench='^BenchmarkResponseConversion$' \
//	  github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata \
//	  -memprofile chunked-memprofile.out -count 6 | tee chunked-benchmark.txt
//
// Generate a fixture with:
//
//	go run ./experiments/queryresponsejson/cmd/generate \
//	  -output "$PROM_CHUNKED_FIXTURE" -min-bytes $((64 * 1024 * 1024))
func BenchmarkResponseConversion(b *testing.B) {
	fixture := os.Getenv("PROM_CHUNKED_FIXTURE")
	if fixture == "" {
		b.Skip("PROM_CHUNKED_FIXTURE is not set")
	}
	info, err := os.Stat(fixture)
	if err != nil {
		b.Fatal(err)
	}
	handler, err := queryresponsejson.NewQueryRangeHandler(fixture)
	if err != nil {
		b.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	query := &models.Query{RefId: "A", Expr: "up", Step: time.Second, RangeQuery: true}
	qd := &QueryData{tracer: tracing.DefaultTracer(), exemplarSampler: exemplar.NewStandardDeviationSampler}
	client := server.Client()
	b.SetBytes(info.Size())

	for _, variant := range []struct {
		name string
		run  func(*http.Response, *countingChunkWriter) error
	}{
		{
			name: "buffered",
			run: func(response *http.Response, _ *countingChunkWriter) error {
				result := qd.parseResponse(context.Background(), query, response)
				return result.Error
			},
		},
		{
			name: "chunked",
			run: func(response *http.Response, writer *countingChunkWriter) error {
				response.Body = &countingReadCloser{ReadCloser: response.Body, bytes: &writer.upstreamBytes}
				err := qd.streamMatrix(context.Background(), query, response, writer)
				closeErr := response.Body.Close()
				if err != nil {
					return err
				}
				return closeErr
			},
		},
	} {
		b.Run(variant.name, func(b *testing.B) {
			var totalFirstChunk time.Duration
			var totalBytesAtFirstChunk int64
			var totalChunkCount int64
			var maxEncodedChunkSize int
			var totalGCCycles uint32
			var totalGCPause time.Duration
			var totalHeapAlloc uint64
			var totalHeapInuse uint64
			b.ResetTimer()
			for range b.N {
				var before runtime.MemStats
				runtime.ReadMemStats(&before)
				response, err := client.Get(server.URL + "/api/v1/query_range")
				if err != nil {
					b.Fatal(err)
				}
				writer := newCountingChunkWriter(time.Now())
				if err := variant.run(response, writer); err != nil {
					b.Fatal(err)
				}
				totalFirstChunk += writer.firstChunk
				totalBytesAtFirstChunk += writer.bytesAtFirstChunk
				totalChunkCount += writer.chunkCount
				if writer.maxEncodedChunkSize > maxEncodedChunkSize {
					maxEncodedChunkSize = writer.maxEncodedChunkSize
				}
				var after runtime.MemStats
				runtime.ReadMemStats(&after)
				totalGCCycles += after.NumGC - before.NumGC
				totalGCPause += time.Duration(after.PauseTotalNs - before.PauseTotalNs)
				totalHeapAlloc += after.HeapAlloc
				totalHeapInuse += after.HeapInuse
			}
			b.StopTimer()
			if b.N > 0 {
				b.ReportMetric(float64(totalGCCycles)/float64(b.N), "gc-cycles/op")
				b.ReportMetric(float64(totalGCPause.Microseconds())/float64(b.N), "gc-pause-us/op")
				b.ReportMetric(float64(totalHeapAlloc)/float64(b.N), "heap-alloc-bytes")
				b.ReportMetric(float64(totalHeapInuse)/float64(b.N), "heap-inuse-bytes")
			}
			if variant.name == "chunked" && b.N > 0 {
				b.ReportMetric(float64(totalFirstChunk.Microseconds())/float64(b.N), "first-chunk-us")
				b.ReportMetric(float64(totalBytesAtFirstChunk)/float64(b.N), "first-chunk-bytes")
				b.ReportMetric(float64(totalChunkCount)/float64(b.N), "chunks/op")
				b.ReportMetric(float64(maxEncodedChunkSize), "max-chunk-bytes")
			}
		})
	}
}

type countingReadCloser struct {
	io.ReadCloser
	bytes *int64
}

func (reader *countingReadCloser) Read(p []byte) (int, error) {
	n, err := reader.ReadCloser.Read(p)
	*reader.bytes += int64(n)
	return n, err
}

type countingChunkWriter struct {
	started             time.Time
	firstChunk          time.Duration
	bytesAtFirstChunk   int64
	upstreamBytes       int64
	chunkCount          int64
	maxEncodedChunkSize int
	writer              backend.ChunkedDataWriter
}

func newCountingChunkWriter(started time.Time) *countingChunkWriter {
	writer := &countingChunkWriter{started: started}
	writer.writer = backend.NewChunkedDataWriter(backend.DataFrameFormat_JSON, func(chunk *pluginv2.QueryChunkedDataResponse) error {
		if writer.firstChunk == 0 {
			writer.firstChunk = time.Since(writer.started)
			writer.bytesAtFirstChunk = writer.upstreamBytes
		}
		writer.chunkCount++
		if len(chunk.Frame) > writer.maxEncodedChunkSize {
			writer.maxEncodedChunkSize = len(chunk.Frame)
		}
		return nil
	})
	return writer
}

func (writer *countingChunkWriter) WriteFrame(ctx context.Context, refID, frameID string, frame *data.Frame) error {
	return writer.writer.WriteFrame(ctx, refID, frameID, frame)
}

func (writer *countingChunkWriter) WriteError(ctx context.Context, refID string, status backend.Status, err error) error {
	return writer.writer.WriteError(ctx, refID, status, err)
}
