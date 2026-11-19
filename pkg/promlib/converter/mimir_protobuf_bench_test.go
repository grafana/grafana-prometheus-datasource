package converter

import (
	"bytes"
	"compress/gzip"
	"io"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	jsoniter "github.com/json-iterator/go"
)

var benchResponseSink backend.DataResponse

// BenchmarkReadQueryResponse decodes the same response from Mimir's JSON and protobuf formats, from a reader as
// parseResponse does. The gzip cases include the decompression that the HTTP transport does for each format.
func BenchmarkReadQueryResponse(b *testing.B) {
	shapes := []struct {
		name     string
		response testResponse
		gzip     bool
	}{
		{"vector_25k_series", promShapedResponse("vector", 25_000, 1, 10), true},
		{"matrix_10_series_60_points", promShapedResponse("matrix", 10, 60, 10), false},
		{"matrix_1k_series_240_points", promShapedResponse("matrix", 1_000, 240, 10), true},
		{"matrix_100_histogram_series_60_points", withHistograms(promShapedResponse("matrix", 100, 60, 10)), false},
	}
	for _, shape := range shapes {
		formats := []struct {
			name string
			body []byte
			read func(io.Reader) backend.DataResponse
		}{
			{"json", shape.response.json(), func(r io.Reader) backend.DataResponse {
				return ReadPrometheusStyleResult(jsoniter.Parse(jsoniter.ConfigDefault, r, 1024), Options{})
			}},
			{"protobuf", shape.response.protobuf(), func(r io.Reader) backend.DataResponse {
				return ReadMimirProtobufResult(r, Options{})
			}},
		}
		for _, format := range formats {
			b.Run("shape="+shape.name+"/body=raw/format="+format.name, func(b *testing.B) {
				for b.Loop() {
					benchResponseSink = format.read(bytes.NewReader(format.body))
				}
				b.ReportMetric(float64(len(format.body)), "body_bytes")
			})
			if !shape.gzip {
				continue
			}
			var compressed bytes.Buffer
			w := gzip.NewWriter(&compressed)
			_, _ = w.Write(format.body)
			_ = w.Close()
			b.Run("shape="+shape.name+"/body=gzip/format="+format.name, func(b *testing.B) {
				for b.Loop() {
					zr, err := gzip.NewReader(bytes.NewReader(compressed.Bytes()))
					if err != nil {
						b.Fatal(err)
					}
					benchResponseSink = format.read(zr)
				}
				b.ReportMetric(float64(compressed.Len()), "body_bytes")
			})
		}
	}
}
