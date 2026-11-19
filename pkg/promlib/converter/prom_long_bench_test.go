package converter

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	jsoniter "github.com/json-iterator/go"
	"github.com/stretchr/testify/require"
)

func makeVectorWorkload(series, labels int) []byte {
	var sb strings.Builder
	sb.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := range series {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"metric":{"id":"device-%06d"`, i)
		for l := 1; l < labels; l++ {
			fmt.Fprintf(&sb, `,"label_%02d":"value-%02d-%04d"`, l, l, i%1000)
		}
		fmt.Fprintf(&sb, `},"value":[1700000000,"%d.5"]}`, i)
	}
	sb.WriteString(`]}}`)
	return []byte(sb.String())
}

/*
BenchmarkInstantTable parses an instant vector and encodes the frames to Arrow, the work the plugin
does before the response crosses gRPC. Compare the two shapes with benchstat:

	go test -run '^$' -bench 'BenchmarkInstantTable' -benchmem -count=10 ./converter/ | tee bench.txt
	benchstat -col /shape bench.txt
*/
func BenchmarkInstantTable(b *testing.B) {
	workloads := []struct {
		series int
		labels int
	}{
		{100, 10},
		{25000, 10},
		{25000, 1},
	}
	for _, w := range workloads {
		input := makeVectorWorkload(w.series, w.labels)
		for _, shape := range []struct {
			name string
			opt  Options
		}{
			{"per-series", Options{}},
			{"long", Options{LongVector: true}},
		} {
			b.Run(fmt.Sprintf("series=%d/labels=%d/shape=%s", w.series, w.labels, shape.name), func(b *testing.B) {
				b.ReportAllocs()
				var arrowBytes int
				for b.Loop() {
					iter := jsoniter.Parse(jsoniter.ConfigDefault, bytes.NewReader(input), 1024)
					rsp := ReadPrometheusStyleResult(iter, shape.opt)
					require.NoError(b, rsp.Error)
					encoded, err := rsp.Frames.MarshalArrow()
					require.NoError(b, err)
					arrowBytes = 0
					for _, e := range encoded {
						arrowBytes += len(e)
					}
				}
				b.ReportMetric(float64(arrowBytes), "arrow-B/op")
			})
		}
	}
}
