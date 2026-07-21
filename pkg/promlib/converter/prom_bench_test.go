package converter

import (
	"bytes"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	sdkjsoniter "github.com/grafana/grafana-plugin-sdk-go/data/utils/jsoniter"
	jsoniter "github.com/json-iterator/go"
	"github.com/stretchr/testify/require"
)

func readTestData(t *testing.B, filename string) []byte {
	// nolint:gosec
	data, err := os.ReadFile("testdata/" + filename)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// go test -benchmem -run=^$ -bench=BenchmarkReadPrometheusStyleResult_FromFile$ github.com/grafana/grafana-prometheus-datasource/pkg/promlib/converter/ -memprofile pmem.out -count 6 | tee pmem.0.txt
func BenchmarkReadPrometheusStyleResult_FromFile(b *testing.B) {
	workloads := map[string][]byte{
		"matrix-small":      readTestData(b, "prom-query-range.json"),
		"matrix-large":      readTestData(b, "prom-query-range-big.json"),
		"matrix-nan-inf":    makeMatrixWorkload([]int{4096}, true),
		"matrix-uniform":    makeMatrixWorkload(repeatedLengths(32, 256), false),
		"matrix-increasing": makeMatrixWorkload(increasingLengths(32, 16), false),
		"matrix-decreasing": makeMatrixWorkload(decreasingLengths(32, 16), false),
		"matrix-ragged":     makeMatrixWorkload(raggedLengths(32, 8, 512), false),
		"vector":            readTestData(b, "prom-vector.json"),
		"exemplars":         readTestData(b, "prom-exemplars-a.json"),
		"histogram-fixture": readTestData(b, "prom-matrix-histogram-partitioned.json"),
		"histogram-uniform": makeHistogramWorkload(repeatedLengths(16, 32), 8),
		"histogram-ragged":  makeHistogramWorkload(raggedLengths(16, 4, 64), 8),
	}

	opt := Options{}
	for name, input := range workloads {
		b.Run(name+"/bytes", func(b *testing.B) {
			iter := jsoniter.ParseBytes(jsoniter.ConfigDefault, input)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				rsp := ReadPrometheusStyleResult(iter, opt)
				require.NoError(b, rsp.Error)
				iter.ResetBytes(input)
			}
		})
		b.Run(name+"/reader-1024", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				iter := jsoniter.Parse(jsoniter.ConfigDefault, bytes.NewReader(input), 1024)
				rsp := ReadPrometheusStyleResult(iter, opt)
				require.NoError(b, rsp.Error)
			}
		})
	}
}

func BenchmarkReadTimeValuePair(b *testing.B) {
	for _, value := range []string{"1.25", "1.25e10", "NaN", "+Inf", "-Inf"} {
		b.Run(value, func(b *testing.B) {
			input := []byte(`[1642000000.125,"` + value + `"]`)
			iter := jsoniter.ParseBytes(jsoniter.ConfigDefault, input)
			wrapped := sdkjsoniter.NewIterator(iter)
			b.ReportAllocs()
			for b.Loop() {
				_, _, err := readTimeValuePair(wrapped)
				require.NoError(b, err)
				iter.ResetBytes(input)
			}
		})
	}
}

func BenchmarkMatrixFieldConstruction(b *testing.B) {
	workloads := map[string][]int{
		"uniform":    repeatedLengths(32, 256),
		"increasing": increasingLengths(32, 16),
		"decreasing": decreasingLengths(32, 16),
		"ragged":     raggedLengths(32, 8, 512),
	}
	for name, lengths := range workloads {
		b.Run(name+"/slices", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkFrames = buildMatrixFieldsWithSlices(lengths)
			}
		})
		b.Run(name+"/scratch-copy", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkFrames = buildMatrixFieldsWithScratch(lengths)
			}
		})
		b.Run(name+"/fields", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkFrames = buildMatrixFieldsDirectly(lengths)
			}
		})
	}
}

func BenchmarkHistogramFieldConstruction(b *testing.B) {
	workloads := map[string][]int{
		"uniform": repeatedLengths(16, 256),
		"ragged":  raggedLengths(16, 32, 512),
	}
	for name, lengths := range workloads {
		b.Run(name+"/typed-slices", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkFrames = buildHistogramFieldsWithSlices(lengths)
			}
		})
		b.Run(name+"/fields", func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				benchmarkFrames = buildHistogramFieldsDirectly(lengths)
			}
		})
	}
}

func buildMatrixFieldsWithSlices(lengths []int) []*data.Frame {
	frames := make([]*data.Frame, 0, len(lengths))
	size := 0
	for _, length := range lengths {
		times := make([]time.Time, 0, size)
		values := make([]float64, 0, size)
		for i := 0; i < length; i++ {
			times = append(times, time.Unix(int64(i), 0))
			values = append(values, float64(i))
		}
		frames = append(frames, data.NewFrame("",
			data.NewField(data.TimeSeriesTimeFieldName, nil, times),
			data.NewField(data.TimeSeriesValueFieldName, nil, values),
		))
		size = length
	}
	return frames
}

func buildMatrixFieldsWithScratch(lengths []int) []*data.Frame {
	frames := make([]*data.Frame, 0, len(lengths))
	var scratchTimes []time.Time
	var scratchValues []float64
	for _, length := range lengths {
		scratchTimes = scratchTimes[:0]
		scratchValues = scratchValues[:0]
		for i := 0; i < length; i++ {
			scratchTimes = append(scratchTimes, time.Unix(int64(i), 0))
			scratchValues = append(scratchValues, float64(i))
		}
		times := append([]time.Time(nil), scratchTimes...)
		values := append([]float64(nil), scratchValues...)
		frames = append(frames, data.NewFrame("",
			data.NewField(data.TimeSeriesTimeFieldName, nil, times),
			data.NewField(data.TimeSeriesValueFieldName, nil, values),
		))
	}
	return frames
}

func buildMatrixFieldsDirectly(lengths []int) []*data.Frame {
	frames := make([]*data.Frame, 0, len(lengths))
	size := 0
	for _, length := range lengths {
		timeField := data.NewFieldFromFieldType(data.FieldTypeTime, 0)
		valueField := data.NewFieldFromFieldType(data.FieldTypeFloat64, 0)
		timeField.Grow(size)
		valueField.Grow(size)
		for i := 0; i < length; i++ {
			timeField.Append(time.Unix(int64(i), 0))
			valueField.Append(float64(i))
		}
		frames = append(frames, data.NewFrame("", timeField, valueField))
		size = length
	}
	return frames
}

func buildHistogramFieldsWithSlices(lengths []int) []*data.Frame {
	frames := make([]*data.Frame, 0, len(lengths))
	size := 0
	for _, length := range lengths {
		times := make([]time.Time, 0, size)
		yMins := make([]float64, 0, size)
		yMaxes := make([]float64, 0, size)
		counts := make([]float64, 0, size)
		yLayouts := make([]int8, 0, size)
		for i := 0; i < length; i++ {
			times = append(times, time.Unix(int64(i), 0))
			yMins = append(yMins, float64(i))
			yMaxes = append(yMaxes, float64(i+1))
			counts = append(counts, float64(i+2))
			yLayouts = append(yLayouts, 1)
		}
		frames = append(frames, data.NewFrame("",
			data.NewField("xMax", nil, times),
			data.NewField("yMin", nil, yMins),
			data.NewField("yMax", nil, yMaxes),
			data.NewField("count", nil, counts),
			data.NewField("yLayout", nil, yLayouts),
		))
		size = length
	}
	return frames
}

func buildHistogramFieldsDirectly(lengths []int) []*data.Frame {
	frames := make([]*data.Frame, 0, len(lengths))
	size := 0
	for _, length := range lengths {
		timeField := data.NewFieldFromFieldType(data.FieldTypeTime, 0)
		yMinField := data.NewFieldFromFieldType(data.FieldTypeFloat64, 0)
		yMaxField := data.NewFieldFromFieldType(data.FieldTypeFloat64, 0)
		countField := data.NewFieldFromFieldType(data.FieldTypeFloat64, 0)
		yLayoutField := data.NewFieldFromFieldType(data.FieldTypeInt8, 0)
		for _, field := range []*data.Field{timeField, yMinField, yMaxField, countField, yLayoutField} {
			field.Grow(size)
		}
		for i := 0; i < length; i++ {
			timeField.Append(time.Unix(int64(i), 0))
			yMinField.Append(float64(i))
			yMaxField.Append(float64(i + 1))
			countField.Append(float64(i + 2))
			yLayoutField.Append(int8(1))
		}
		frames = append(frames, data.NewFrame("", timeField, yMinField, yMaxField, countField, yLayoutField))
		size = length
	}
	return frames
}

func repeatedLengths(count, length int) []int {
	lengths := make([]int, count)
	for i := range lengths {
		lengths[i] = length
	}
	return lengths
}

func increasingLengths(count, step int) []int {
	lengths := make([]int, count)
	for i := range lengths {
		lengths[i] = (i + 1) * step
	}
	return lengths
}

func decreasingLengths(count, step int) []int {
	lengths := increasingLengths(count, step)
	for left, right := 0, len(lengths)-1; left < right; left, right = left+1, right-1 {
		lengths[left], lengths[right] = lengths[right], lengths[left]
	}
	return lengths
}

func raggedLengths(count, short, long int) []int {
	lengths := make([]int, count)
	for i := range lengths {
		if i%2 == 0 {
			lengths[i] = short
		} else {
			lengths[i] = long
		}
	}
	return lengths
}

func makeMatrixWorkload(lengths []int, specialValues bool) []byte {
	var result strings.Builder
	result.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for series, length := range lengths {
		if series > 0 {
			result.WriteByte(',')
		}
		fmt.Fprintf(&result, `{"metric":{"series":"%d"},"values":[`, series)
		for sample := 0; sample < length; sample++ {
			if sample > 0 {
				result.WriteByte(',')
			}
			value := strconv.FormatFloat(float64(sample)/10, 'g', -1, 64)
			if specialValues {
				switch sample % 8 {
				case 0:
					value = "NaN"
				case 1:
					value = "+Inf"
				case 2:
					value = "-Inf"
				case 3:
					value = "1.25e10"
				}
			}
			fmt.Fprintf(&result, `[%d,"%s"]`, 1642000000+sample, value)
		}
		result.WriteString(`]}`)
	}
	result.WriteString(`]}}`)
	return []byte(result.String())
}

func makeHistogramWorkload(bucketCounts []int, histogramCount int) []byte {
	var result strings.Builder
	result.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for series, bucketCount := range bucketCounts {
		if series > 0 {
			result.WriteByte(',')
		}
		fmt.Fprintf(&result, `{"metric":{"series":"%d"},"histograms":[`, series)
		for histogram := 0; histogram < histogramCount; histogram++ {
			if histogram > 0 {
				result.WriteByte(',')
			}
			fmt.Fprintf(&result, `[%d,{"count":"%d","sum":"1","buckets":[`, 1642000000+histogram, bucketCount)
			for bucket := 0; bucket < bucketCount; bucket++ {
				if bucket > 0 {
					result.WriteByte(',')
				}
				fmt.Fprintf(&result, `[1,"%d","%d","%d"]`, bucket, bucket+1, bucket+2)
			}
			result.WriteString(`]}]`)
		}
		result.WriteString(`]}`)
	}
	result.WriteString(`]}}`)
	return []byte(result.String())
}

var benchmarkFrames []*data.Frame
