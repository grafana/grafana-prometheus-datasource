package converter

import (
	"fmt"
	"maps"
	"math"
	"math/rand/v2"
	"os"
	"path"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	sdkjsoniter "github.com/grafana/grafana-plugin-sdk-go/data/utils/jsoniter"
	jsoniter "github.com/json-iterator/go"
	"github.com/stretchr/testify/require"
)

type table struct {
	keys   []string
	times  []time.Time
	cols   map[string][]string
	values []float64
}

// tableFromSeriesFrames builds the table that transformDFToTable in @grafana/prometheus builds
// from one numeric-multi frame per series.
func tableFromSeriesFrames(frames data.Frames) table {
	tbl := table{cols: map[string][]string{}}
	for _, f := range frames {
		for _, key := range slices.Sorted(maps.Keys(f.Fields[1].Labels)) {
			if _, ok := tbl.cols[key]; !ok {
				tbl.keys = append(tbl.keys, key)
				tbl.cols[key] = []string{}
			}
		}
	}
	for _, f := range frames {
		for i := range f.Rows() {
			tbl.times = append(tbl.times, f.Fields[0].At(i).(time.Time))
			tbl.values = append(tbl.values, f.Fields[1].At(i).(float64))
			for _, key := range tbl.keys {
				tbl.cols[key] = append(tbl.cols[key], f.Fields[1].Labels[key])
			}
		}
	}
	return tbl
}

func tableFromLongFrame(t *testing.T, f *data.Frame) table {
	t.Helper()
	tbl := table{cols: map[string][]string{}}
	last := len(f.Fields) - 1
	require.Equal(t, data.TimeSeriesTimeFieldName, f.Fields[0].Name)
	require.Equal(t, data.TimeSeriesValueFieldName, f.Fields[last].Name)
	for _, field := range f.Fields[1:last] {
		tbl.keys = append(tbl.keys, field.Name)
		tbl.cols[field.Name] = []string{}
	}
	for i := range f.Rows() {
		tbl.times = append(tbl.times, f.Fields[0].At(i).(time.Time))
		tbl.values = append(tbl.values, f.Fields[last].At(i).(float64))
		for j, field := range f.Fields[1:last] {
			var v string
			if p := field.At(i).(*string); p != nil {
				v = *p
			}
			tbl.cols[tbl.keys[j]] = append(tbl.cols[tbl.keys[j]], v)
		}
	}
	return tbl
}

func requireSameTable(t *testing.T, want, got table) {
	t.Helper()
	require.Equal(t, want.keys, got.keys, "label columns")
	require.Equal(t, want.times, got.times, "times")
	require.Equal(t, want.cols, got.cols, "label values")
	require.Equal(t, len(want.values), len(got.values), "rows")
	for i := range want.values {
		require.Equal(t, math.Float64bits(want.values[i]), math.Float64bits(got.values[i]), "value of row %d", i)
	}
}

// requireLongMatchesSeriesFrames reads input both ways and asserts that the long frame holds the
// table built from the per-series frames, and that native histogram frames are unchanged.
func requireLongMatchesSeriesFrames(t *testing.T, input string) {
	t.Helper()
	multi := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, []byte(input)), Options{})
	long := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, []byte(input)), Options{LongVector: true})
	require.NoError(t, multi.Error)
	require.NoError(t, long.Error)

	var series, multiHistograms data.Frames
	for _, f := range multi.Frames {
		if f.Meta.Type == data.FrameTypeNumericMulti {
			series = append(series, f)
		} else {
			multiHistograms = append(multiHistograms, f)
		}
	}
	longHistograms := long.Frames
	if len(series) > 0 {
		require.Equal(t, data.FrameTypeNumericLong, long.Frames[0].Meta.Type)
		requireSameTable(t, tableFromSeriesFrames(series), tableFromLongFrame(t, long.Frames[0]))
		longHistograms = long.Frames[1:]
	}
	require.Equal(t, len(multiHistograms), len(longHistograms), "native histogram frames")
	for i := range multiHistograms {
		want, err := data.FrameToJSON(multiHistograms[i], data.IncludeAll)
		require.NoError(t, err)
		got, err := data.FrameToJSON(longHistograms[i], data.IncludeAll)
		require.NoError(t, err)
		require.JSONEq(t, string(want), string(got))
	}
}

var vectorEdgeCases = []struct {
	name   string
	result string
}{
	{"empty", ``},
	{"one series without labels", `{"metric":{},"value":[1700000000,"1"]}`},
	{"new keys keep first-seen order", `{"metric":{"job":"a"},"value":[1700000000,"1"]},{"metric":{"instance":"i","job":"b"},"value":[1700000000,"2"]},{"metric":{"az":"z"},"value":[1700000000,"3"]}`},
	{"special values", `{"metric":{"v":"nan"},"value":[1700000000,"NaN"]},{"metric":{"v":"inf"},"value":[1700000000,"+Inf"]},{"metric":{"v":"-inf"},"value":[1700000000,"-Inf"]}`},
	{"times out of order", `{"metric":{"a":"1"},"value":[1700000005.25,"1"]},{"metric":{"a":"2"},"value":[1700000000,"2"]}`},
	{"duplicate label sets", `{"metric":{"a":"1"},"value":[1700000000,"1"]},{"metric":{"a":"1"},"value":[1700000000,"2"]}`},
	{"float and native histogram series", `{"metric":{"job":"a"},"value":[1700000000,"1"]},{"metric":{"job":"h"},"histogram":[1700000000,{"count":"3","sum":"4.5","buckets":[[0,"1","2","3"]]}]},{"metric":{"zone":"z"},"value":[1700000000,"2"]}`},
}

func vectorResponse(result string) string {
	return `{"status":"success","data":{"resultType":"vector","result":[` + result + `]}}`
}

func TestReadVectorLongMatchesSeriesFrames(t *testing.T) {
	for _, tc := range vectorEdgeCases {
		t.Run(tc.name, func(t *testing.T) {
			requireLongMatchesSeriesFrames(t, vectorResponse(tc.result))
		})
	}
}

// randomVector returns a vector response of up to 40 series with ragged label sets, special values and,
// for about one series in ten, a native histogram sample.
func randomVector(rng *rand.Rand) string {
	keys := []string{"__name__", "az", "id", "instance", "job", "le", "zone"}
	values := []string{"0", "1", "-2.5", "1e300", "NaN", "+Inf", "-Inf"}
	var sb strings.Builder
	sb.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := range rng.IntN(40) {
		if i > 0 {
			sb.WriteByte(',')
		}
		var labels []string
		for _, key := range keys {
			if rng.IntN(3) > 0 {
				labels = append(labels, fmt.Sprintf(`"%s":"v%d"`, key, rng.IntN(4)))
			}
		}
		ts := fmt.Sprintf("%d.%03d", 1700000000+rng.IntN(3), rng.IntN(1000))
		if rng.IntN(10) == 0 {
			fmt.Fprintf(&sb, `{"metric":{%s},"histogram":[%s,{"count":"3","sum":"4.5","buckets":[[0,"1","2","3"]]}]}`, strings.Join(labels, ","), ts)
			continue
		}
		fmt.Fprintf(&sb, `{"metric":{%s},"value":[%s,"%s"]}`, strings.Join(labels, ","), ts, values[rng.IntN(len(values))])
	}
	sb.WriteString(`]}}`)
	return sb.String()
}

func TestReadVectorLongMatchesSeriesFramesRandom(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	for n := range 500 {
		input := randomVector(rng)
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			requireLongMatchesSeriesFrames(t, input)
		})
	}
}

// vectorResult returns an iterator at the result array of a vector response.
func vectorResult(t *testing.T, input string) *sdkjsoniter.Iterator {
	t.Helper()
	iter := sdkjsoniter.NewIterator(jsoniter.ParseString(sdkjsoniter.ConfigDefault, input))
	for l1, err := iter.ReadObject(); l1 != ""; l1, err = iter.ReadObject() {
		require.NoError(t, err)
		if l1 != "data" {
			require.NoError(t, iter.Skip())
			continue
		}
		for l2, err := iter.ReadObject(); l2 != ""; l2, err = iter.ReadObject() {
			require.NoError(t, err)
			if l2 == "result" {
				return iter
			}
			require.NoError(t, iter.Skip())
		}
	}
	t.Fatal("response has no result array")
	return nil
}

func requireSameAsReference(t *testing.T, input string) {
	t.Helper()
	want := readVectorLongReference(vectorResult(t, input))
	got := readVectorLong(vectorResult(t, input))
	require.Equal(t, want.Error, got.Error)
	require.Len(t, got.Frames, len(want.Frames))
	for i := range want.Frames {
		w, err := want.Frames[i].MarshalArrow()
		require.NoError(t, err)
		g, err := got.Frames[i].MarshalArrow()
		require.NoError(t, err)
		require.Equal(t, w, g, "frame %d", i)
	}
}

func TestReadVectorLongMatchesReference(t *testing.T) {
	for _, tc := range vectorEdgeCases {
		t.Run(tc.name, func(t *testing.T) {
			requireSameAsReference(t, vectorResponse(tc.result))
		})
	}
	t.Run("ragged label sets", func(t *testing.T) {
		requireSameAsReference(t, string(makeRaggedVectorWorkload(300, 50)))
	})
	rng := rand.New(rand.NewPCG(3, 4))
	for n := range 500 {
		input := randomVector(rng)
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			requireSameAsReference(t, input)
		})
	}
}

func TestReadVectorLongRaggedLabelsBytes(t *testing.T) {
	const ceiling = 16 << 20
	input := makeRaggedVectorWorkload(2500, 200)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	rsp := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{LongVector: true})
	runtime.ReadMemStats(&after)
	require.NoError(t, rsp.Error)
	if got := after.TotalAlloc - before.TotalAlloc; got > ceiling {
		t.Errorf("reading 2,500 series with 210 label keys as a long frame allocated %d bytes, want at most %d", got, ceiling)
	}
}

func TestReadVectorLongAllocs(t *testing.T) {
	const ceiling = 55000
	input := makeVectorWorkload(1000, 10)
	allocs := testing.AllocsPerRun(10, func() {
		rsp := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{LongVector: true})
		if rsp.Error != nil {
			t.Fatal(rsp.Error)
		}
		if _, err := rsp.Frames.MarshalArrow(); err != nil {
			t.Fatal(err)
		}
	})
	if allocs > ceiling {
		t.Errorf("reading and encoding 1,000 series as a long frame took %.0f allocations, want at most %d", allocs, ceiling)
	}
}

func readLong(t *testing.T, input string) data.Frames {
	t.Helper()
	rsp := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, []byte(input)), Options{LongVector: true})
	require.NoError(t, rsp.Error)
	return rsp.Frames
}

func TestReadVectorLong(t *testing.T) {
	frames := readLong(t, `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"__name__":"up","job":"b","instance":"i1"},"value":[1700000000,"1"]},
		{"metric":{"__name__":"up","job":"a","zone":"z1"},"value":[1700000000,"NaN"]},
		{"metric":{},"value":[1700000001.5,"+Inf"]},
		{"metric":{"job":"c","instance":"i3","zone":"z3"},"value":[1700000000,"2.5"]}
	]}}`)
	require.Len(t, frames, 1)
	frame := frames[0]

	require.Equal(t, data.FrameTypeNumericLong, frame.Meta.Type)
	require.Equal(t, data.FrameTypeVersion{0, 1}, frame.Meta.TypeVersion)
	require.Equal(t, map[string]any{"resultType": "vector"}, frame.Meta.Custom)
	require.Equal(t, 4, frame.Rows())

	names := make([]string, 0, len(frame.Fields))
	for _, f := range frame.Fields {
		names = append(names, f.Name)
		require.Nil(t, f.Labels, "long frame fields carry no labels")
	}
	require.Equal(t, []string{"Time", "__name__", "instance", "job", "zone", "Value"}, names)

	require.Equal(t, data.FieldTypeTime, frame.Fields[0].Type())
	require.Equal(t, time.Unix(1700000001, 500000000).UTC(), frame.Fields[0].At(2))

	column := func(idx int) []any {
		require.Equal(t, data.FieldTypeNullableString, frame.Fields[idx].Type(), frame.Fields[idx].Name)
		out := make([]any, frame.Rows())
		for i := range out {
			if v := frame.Fields[idx].At(i).(*string); v != nil {
				out[i] = *v
			}
		}
		return out
	}
	require.Equal(t, []any{"up", "up", nil, nil}, column(1))
	require.Equal(t, []any{"i1", nil, nil, "i3"}, column(2))
	require.Equal(t, []any{"b", "a", nil, "c"}, column(3))
	require.Equal(t, []any{nil, "z1", nil, "z3"}, column(4))

	values := frame.Fields[5]
	require.Equal(t, data.FieldTypeFloat64, values.Type())
	require.Equal(t, 1.0, values.At(0))
	require.True(t, math.IsNaN(values.At(1).(float64)))
	require.Equal(t, math.Inf(1), values.At(2))
	require.Equal(t, 2.5, values.At(3))
}

func TestReadVectorLongEmptyResult(t *testing.T) {
	require.Empty(t, readLong(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`))
}

func TestReadVectorLongNativeHistogramKeepsHeatmapFrame(t *testing.T) {
	frames := readLong(t, `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"job":"a"},"value":[1700000000,"1"]},
		{"metric":{"job":"h"},"histogram":[1700000000,{"count":"3","sum":"4.5","buckets":[[0,"1","2","3"]]}]}
	]}}`)
	require.Len(t, frames, 2)
	require.Equal(t, data.FrameTypeNumericLong, frames[0].Meta.Type)
	require.Equal(t, 1, frames[0].Rows())
	require.Equal(t, data.FrameType("heatmap-cells"), frames[1].Meta.Type)
	require.Equal(t, data.Labels{"job": "h"}, frames[1].Fields[0].Labels)
}

// LongVector only changes vector results. Every other fixture must produce the
// same frames with and without the option.
func TestLongVectorLeavesOtherResultTypesUnchanged(t *testing.T) {
	for _, name := range files {
		t.Run(name, func(t *testing.T) {
			input, err := os.ReadFile(path.Join("testdata", name+".json"))
			require.NoError(t, err)

			multi := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{})
			long := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{LongVector: true})
			if multi.Error != nil {
				require.EqualError(t, long.Error, multi.Error.Error())
				return
			}
			for _, f := range multi.Frames {
				if f.Meta != nil && f.Meta.Type == data.FrameTypeNumericMulti && f.Meta.Custom.(map[string]any)["resultType"] == "vector" {
					t.Skip("vector fixture: shape changes by design")
				}
			}
			require.Equal(t, len(multi.Frames), len(long.Frames))
			for i := range multi.Frames {
				want, err := data.FrameToJSON(multi.Frames[i], data.IncludeAll)
				require.NoError(t, err)
				got, err := data.FrameToJSON(long.Frames[i], data.IncludeAll)
				require.NoError(t, err)
				require.JSONEq(t, string(want), string(got))
			}
		})
	}
}

// readVectorLongReference grows every label column by one row per series. TestReadVectorLongMatchesReference
// checks that readVectorLong returns the same frames.
func readVectorLongReference(iter *sdkjsoniter.Iterator) backend.DataResponse {
	rsp := backend.DataResponse{}
	var times []time.Time
	var values []float64
	labelCols := map[string][]string{}
	var labelKeys []string

	for more, err := iter.ReadArray(); more; more, err = iter.ReadArray() {
		if err != nil {
			return rspErr(err)
		}

		var labels data.Labels
		var histogram *histogramInfo
		var t time.Time
		var v float64
		hasValue := false

		for l1Field, err := iter.ReadObject(); l1Field != ""; l1Field, err = iter.ReadObject() {
			if err != nil {
				return rspErr(err)
			}
			switch l1Field {
			case "metric":
				if err = iter.ReadVal(&labels); err != nil {
					return rspErr(err)
				}

			case "value":
				if t, v, err = readTimeValuePair(iter); err != nil {
					return rspErr(err)
				}
				hasValue = true

			case "histogram":
				histogram = newHistogramInfo(0)
				if err = readHistogram(iter, histogram); err != nil {
					return rspErr(err)
				}

			default:
				if err = iter.Skip(); err != nil {
					return rspErr(err)
				}
				logf("readVectorLongReference: %s\n", l1Field)
			}
		}

		if histogram != nil {
			rsp.Frames = append(rsp.Frames, newHeatmapFrame(labels, histogram))
			continue
		}
		if !hasValue {
			continue
		}

		row := len(times)
		times = append(times, t)
		values = append(values, v)
		var newKeys []string
		for key, val := range labels {
			col, ok := labelCols[key]
			if !ok {
				col = make([]string, row, row+1)
				newKeys = append(newKeys, key)
			}
			labelCols[key] = append(col, val)
		}
		// Columns appear in first-seen order, and each series adds its new keys sorted.
		slices.Sort(newKeys)
		labelKeys = append(labelKeys, newKeys...)
		for key, col := range labelCols {
			if len(col) == row {
				labelCols[key] = append(col, "")
			}
		}
	}

	if len(times) == 0 {
		return rsp
	}

	fields := make([]*data.Field, 0, len(labelKeys)+2)
	fields = append(fields, data.NewField(data.TimeSeriesTimeFieldName, nil, times))
	for _, key := range labelKeys {
		col := labelCols[key]
		nullable := make([]*string, len(col))
		for i := range col {
			if col[i] != "" {
				nullable[i] = &col[i]
			}
		}
		fields = append(fields, data.NewField(key, nil, nullable))
	}
	fields = append(fields, data.NewField(data.TimeSeriesValueFieldName, nil, values))

	frame := data.NewFrame("", fields...)
	frame.Meta = &data.FrameMeta{
		Type:        data.FrameTypeNumericLong,
		Custom:      resultTypeToCustomMeta("vector"),
		TypeVersion: data.FrameTypeVersion{0, 1},
	}
	rsp.Frames = append(data.Frames{frame}, rsp.Frames...)
	return rsp
}
