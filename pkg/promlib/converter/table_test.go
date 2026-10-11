package converter

import (
	"fmt"
	"math"
	"os"
	"path"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	jsoniter "github.com/json-iterator/go"
	"github.com/stretchr/testify/require"
)

func readVector(t *testing.T, body string, asTable bool) []*data.Frame {
	t.Helper()
	iter := jsoniter.ParseString(jsoniter.ConfigDefault, body)
	rsp := ReadPrometheusStyleResult(iter, Options{VectorAsTable: asTable})
	require.NoError(t, rsp.Error)
	return rsp.Frames
}

// jsSort sorts like JavaScript's default Array.prototype.sort, by UTF-16 code units.
func jsSort(keys []string) {
	slices.SortFunc(keys, func(a, b string) int { return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b))) })
}

// legacyToTable mirrors transformDFToTable in the frontend.
func legacyToTable(frames []*data.Frame) (names []string, times []time.Time, cols [][]string, values []float64) {
	seen := map[string]bool{}
	for _, f := range frames {
		var keys []string
		for k := range f.Fields[1].Labels {
			keys = append(keys, k)
		}
		jsSort(keys)
		for _, k := range keys {
			if !seen[k] {
				seen[k] = true
				names = append(names, k)
				cols = append(cols, nil)
			}
		}
	}
	for _, f := range frames {
		for i := range f.Fields[0].Len() {
			times = append(times, f.Fields[0].At(i).(time.Time))
			values = append(values, f.Fields[1].At(i).(float64))
			for c, name := range names {
				cols[c] = append(cols[c], f.Fields[1].Labels[name])
			}
		}
	}
	return
}

func requireTableMatchesLegacy(t *testing.T, body string) {
	t.Helper()
	legacy := readVector(t, body, false)
	frames := readVector(t, body, true)
	require.Len(t, frames, 1)
	frame := frames[0]
	names, times, cols, values := legacyToTable(legacy)
	require.Len(t, frame.Fields, len(names)+2)
	for i := range times {
		require.Equal(t, times[i], frame.Fields[0].At(i))
		require.Equal(t, math.Float64bits(values[i]), math.Float64bits(frame.Fields[len(frame.Fields)-1].At(i).(float64)), "row %d", i)
	}
	for c, name := range names {
		require.Equal(t, name, frame.Fields[c+1].Name, "column %d", c)
		for i := range times {
			require.Equal(t, cols[c][i], frame.Fields[c+1].At(i), "label %s row %d", name, i)
		}
	}
}

func TestVectorAsTableOrdersLabelsLikeJavaScript(t *testing.T) {
	// U+FF21 sorts after U+1F600 in UTF-16 (0xFF21 > 0xD83D) but before it in UTF-8 byte order.
	requireTableMatchesLegacy(t, `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"\uff21":"a","\ud83d\ude00":"b","z":"c","\u00e9":"d","\ud83d\ude01":"e","A":"f"},"value":[1700000000,"1"]},
		{"metric":{"\uffff":"g","\ud800\udc00":"h","a":"i"},"value":[1700000000,"2"]}
	]}}`)
	frame := readVector(t, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"\uff21":"a","\ud83d\ude00":"b"},"value":[1700000000,"1"]}]}}`, true)[0]
	require.Equal(t, "\U0001F600", frame.Fields[1].Name)
}

func TestVectorAsTableFallsBackWhenSparse(t *testing.T) {
	sparse := func(series int) string {
		var sb strings.Builder
		sb.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
		for i := range series {
			if i > 0 {
				sb.WriteByte(',')
			}
			fmt.Fprintf(&sb, `{"metric":{"job":"j","label_%d":"x"},"value":[1700000000,"%d"]}`, i, i)
		}
		sb.WriteString(`]}}`)
		return sb.String()
	}

	t.Run("one distinct label per series returns one frame per series", func(t *testing.T) {
		body := sparse(2000)
		require.Equal(t, readVector(t, body, false), readVector(t, body, true))
	})

	t.Run("small sparse tables stay one frame", func(t *testing.T) {
		requireTableMatchesLegacy(t, sparse(100))
	})

	t.Run("allocations stay close to one frame per series", func(t *testing.T) {
		body := sparse(2000)
		legacy := testing.Benchmark(func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				ReadPrometheusStyleResult(jsoniter.ParseString(jsoniter.ConfigDefault, body), Options{})
			}
		})
		table := testing.Benchmark(func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				ReadPrometheusStyleResult(jsoniter.ParseString(jsoniter.ConfigDefault, body), Options{VectorAsTable: true})
			}
		})
		require.Less(t, table.AllocedBytesPerOp(), 2*legacy.AllocedBytesPerOp())
	})
}

func TestVectorAsTableFallsBackBeforeAddingWideSeries(t *testing.T) {
	body := func(wideFirst bool) string {
		var wide strings.Builder
		wide.WriteString(`{"metric":{`)
		for i := range 1000 {
			if i > 0 {
				wide.WriteByte(',')
			}
			fmt.Fprintf(&wide, `"wide_%d":"x"`, i)
		}
		wide.WriteString(`},"value":[1700000000,"0"]}`)

		series := make([]string, 0, 4001)
		for i := range 4000 {
			series = append(series, fmt.Sprintf(`{"metric":{"job":"j","pod":"p%d"},"value":[1700000000,"%d"]}`, i, i))
		}
		if wideFirst {
			series = append([]string{wide.String()}, series...)
		} else {
			series = append(series, wide.String())
		}
		return `{"status":"success","data":{"resultType":"vector","result":[` + strings.Join(series, ",") + `]}}`
	}

	for _, wideFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("wide series first=%v", wideFirst), func(t *testing.T) {
			b := body(wideFirst)
			require.Equal(t, readVector(t, b, false), readVector(t, b, true))

			legacy := testing.Benchmark(func(bm *testing.B) {
				bm.ReportAllocs()
				for bm.Loop() {
					ReadPrometheusStyleResult(jsoniter.ParseString(jsoniter.ConfigDefault, b), Options{})
				}
			})
			table := testing.Benchmark(func(bm *testing.B) {
				bm.ReportAllocs()
				for bm.Loop() {
					ReadPrometheusStyleResult(jsoniter.ParseString(jsoniter.ConfigDefault, b), Options{VectorAsTable: true})
				}
			})
			require.Less(t, table.AllocedBytesPerOp(), 2*legacy.AllocedBytesPerOp())
		})
	}
}

func TestVectorAsTableFallbackKeepsLabelsExact(t *testing.T) {
	// empty label values and repeated keys must survive the histogram fallback unchanged
	body := `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"job":"","env":"prod"},"value":[1700000000,"1"]},
		{"metric":{"job":"a","job":"b"},"value":[1700000000,"2"]},
		{"metric":{"job":"h"},"histogram":[1700000000,{"count":"2","sum":"3","buckets":[[0,"0","1","2"]]}]}
	]}}`
	require.Equal(t, readVector(t, body, false), readVector(t, body, true))
}

func TestVectorAsTable(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"job":"a","__name__":"up"},"value":[1700000000,"1"]},
		{"metric":{"zone":"z1","instance":"i1"},"value":[1700000000,"NaN"]},
		{"metric":{},"value":[1700000000,"+Inf"]},
		{"metric":{"job":"b","alpha":"x"},"value":[1700000000,"-2.5"]}
	]}}`

	legacy := readVector(t, body, false)
	require.Len(t, legacy, 4)
	frames := readVector(t, body, true)
	require.Len(t, frames, 1)

	frame := frames[0]
	require.Equal(t, data.FrameTypeNumericLong, frame.Meta.Type)
	require.Equal(t, map[string]any{"resultType": "vector"}, frame.Meta.Custom)

	names, times, cols, values := legacyToTable(legacy)
	require.Equal(t, []string{"__name__", "job", "instance", "zone", "alpha"}, names)
	require.Len(t, frame.Fields, len(names)+2)
	require.Equal(t, data.TimeSeriesTimeFieldName, frame.Fields[0].Name)
	require.Equal(t, data.TimeSeriesValueFieldName, frame.Fields[len(frame.Fields)-1].Name)
	for i := range times {
		require.Equal(t, times[i], frame.Fields[0].At(i))
		require.Equal(t, math.Float64bits(values[i]), math.Float64bits(frame.Fields[len(frame.Fields)-1].At(i).(float64)), "row %d", i)
	}
	for c, name := range names {
		field := frame.Fields[c+1]
		require.Equal(t, name, field.Name)
		require.True(t, *field.Config.Filterable)
		for i := range times {
			require.Equal(t, cols[c][i], field.At(i), "label %s row %d", name, i)
		}
	}
}

func TestVectorAsTableSortsByTime(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"vector","result":[
		{"metric":{"job":"a"},"value":[1700000010,"1"]},
		{"metric":{"job":"b"},"value":[1700000000,"2"]},
		{"metric":{"job":"c"},"value":[1700000010,"3"]}
	]}}`
	frame := readVector(t, body, true)[0]
	require.Equal(t, []string{"b", "a", "c"}, []string{frame.Fields[1].At(0).(string), frame.Fields[1].At(1).(string), frame.Fields[1].At(2).(string)})
	require.Equal(t, 2.0, frame.Fields[2].At(0))
}

func TestVectorAsTableKeepsOtherResults(t *testing.T) {
	t.Run("empty vector returns no frames", func(t *testing.T) {
		require.Empty(t, readVector(t, `{"status":"success","data":{"resultType":"vector","result":[]}}`, true))
	})

	t.Run("matrix is unchanged", func(t *testing.T) {
		body := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"a"},"values":[[1700000000,"1"]]}]}}`
		require.Equal(t, readVector(t, body, false), readVector(t, body, true))
	})

	for _, name := range []string{"prom-vector-histogram-no-labels", "prom-vector", "prom-warnings"} {
		t.Run(name+" matches legacy frames when it contains histograms", func(t *testing.T) {
			// nolint:gosec
			b, err := os.ReadFile(path.Join("testdata", name+".json"))
			require.NoError(t, err)
			legacy := readVector(t, string(b), false)
			hasHistogram := slices.ContainsFunc(legacy, func(f *data.Frame) bool { return f.Meta != nil && f.Meta.Type == "heatmap-cells" })
			if !hasHistogram {
				t.Skip("no histogram in fixture")
			}
			require.Equal(t, legacy, readVector(t, string(b), true))
		})
	}

	t.Run("histogram after float series falls back to one frame per series", func(t *testing.T) {
		body := `{"status":"success","data":{"resultType":"vector","result":[
			{"metric":{"job":"a"},"value":[1700000000,"1"]},
			{"metric":{},"value":[1700000000,"2"]},
			{"value":[1700000000,"4"]},
			{"metric":null,"value":[1700000000,"5"]},
			{"metric":{"job":"h"},"histogram":[1700000000,{"count":"2","sum":"3","buckets":[[0,"0","1","2"]]}]},
			{"metric":{"job":"c"},"value":[1700000000,"3"]}
		]}}`
		require.Equal(t, readVector(t, body, false), readVector(t, body, true))
	})
}
