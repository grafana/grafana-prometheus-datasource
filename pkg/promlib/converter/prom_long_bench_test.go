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

// makeRaggedVectorWorkload gives each series 10 labels plus 3 more, taken in turn from a pool of pool keys.
func makeRaggedVectorWorkload(series, pool int) []byte {
	var sb strings.Builder
	sb.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := range series {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"metric":{"id":"device-%06d"`, i)
		for l := 1; l < 10; l++ {
			fmt.Fprintf(&sb, `,"label_%02d":"value-%02d-%04d"`, l, l, i%1000)
		}
		for e := range 3 {
			fmt.Fprintf(&sb, `,"extra_%03d":"x-%04d"`, (i+e)%pool, i%1000)
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
		name  string
		input []byte
	}{
		{"series=100/labels=10", makeVectorWorkload(100, 10)},
		{"series=25000/labels=10", makeVectorWorkload(25000, 10)},
		{"series=25000/labels=1", makeVectorWorkload(25000, 1)},
		{"series=25000/labels=10+3of200", makeRaggedVectorWorkload(25000, 200)},
	}
	for _, w := range workloads {
		for _, shape := range []struct {
			name string
			opt  Options
		}{
			{"per-series", Options{}},
			{"long", Options{LongVector: true}},
		} {
			b.Run(w.name+"/shape="+shape.name, func(b *testing.B) {
				b.ReportAllocs()
				var arrowBytes int
				for b.Loop() {
					iter := jsoniter.Parse(jsoniter.ConfigDefault, bytes.NewReader(w.input), 1024)
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
