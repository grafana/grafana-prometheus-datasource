package querydata

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/tracing"
	"github.com/grafana/grafana-plugin-sdk-go/data"

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
			b.ResetTimer()
			for range b.N {
				response, err := client.Get(server.URL + "/api/v1/query_range")
				if err != nil {
					b.Fatal(err)
				}
				writer := &countingChunkWriter{started: time.Now()}
				if err := variant.run(response, writer); err != nil {
					b.Fatal(err)
				}
				totalFirstChunk += writer.firstChunk
				totalBytesAtFirstChunk += writer.bytesAtFirstChunk
			}
			b.StopTimer()
			if variant.name == "chunked" && b.N > 0 {
				b.ReportMetric(float64(totalFirstChunk.Microseconds())/float64(b.N), "first-chunk-us")
				b.ReportMetric(float64(totalBytesAtFirstChunk)/float64(b.N), "first-chunk-bytes")
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
	started           time.Time
	firstChunk        time.Duration
	bytesAtFirstChunk int64
	upstreamBytes     int64
}

func (writer *countingChunkWriter) WriteFrame(_ context.Context, _ string, _ string, _ *data.Frame) error {
	if writer.firstChunk == 0 {
		writer.firstChunk = time.Since(writer.started)
		writer.bytesAtFirstChunk = writer.upstreamBytes
	}
	return nil
}

func (*countingChunkWriter) WriteError(_ context.Context, _ string, _ backend.Status, err error) error {
	return err
}
