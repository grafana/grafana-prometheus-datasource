package converter

import (
	"math"
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
	sdkjsoniter "github.com/grafana/grafana-plugin-sdk-go/data/utils/jsoniter"
	"github.com/grafana/grafana-plugin-sdk-go/experimental"
	jsoniter "github.com/json-iterator/go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const update = false

var files = []string{
	"prom-labels",
	"prom-matrix",
	"prom-matrix-with-nans",
	"prom-matrix-histogram-no-labels",
	"prom-matrix-histogram-partitioned",
	"prom-vector-histogram-no-labels",
	"prom-vector",
	"prom-string",
	"prom-scalar",
	"prom-series",
	"prom-warnings",
	"prom-warnings-no-data",
	"prom-infos",
	"prom-infos-no-data",
	"prom-error",
	"prom-exemplars-a",
	"prom-exemplars-b",
	"prom-exemplars-diff-labels",
	"prom-query-range",
	"prom-query-range-big",
	"loki-streams-a",
	"loki-streams-b",
	"loki-streams-c",
}

func TestReadPromFrames(t *testing.T) {
	for _, name := range files {
		t.Run(name, runScenario(name, Options{}))
	}
}

func runScenario(name string, opts Options) func(t *testing.T) {
	return func(t *testing.T) {
		// Safe to disable, this is a test.
		// nolint:gosec
		f, err := os.Open(path.Join("testdata", name+".json"))
		require.NoError(t, err)

		iter := jsoniter.Parse(sdkjsoniter.ConfigDefault, f, 1024)
		rsp := ReadPrometheusStyleResult(iter, opts)

		if strings.Contains(name, "error") {
			require.Error(t, rsp.Error)
			return
		}

		if strings.Contains(name, "warnings") {
			hasWarning := false
			for _, frame := range rsp.Frames {
				for _, notice := range frame.Meta.Notices {
					if notice.Severity == data.NoticeSeverityWarning {
						hasWarning = true
						break
					}
				}
				if hasWarning {
					break
				}
			}

			require.True(t, hasWarning)
		}

		if strings.Contains(name, "infos") {
			hasInfo := false
			for _, frame := range rsp.Frames {
				for _, notice := range frame.Meta.Notices {
					if notice.Severity == data.NoticeSeverityInfo {
						hasInfo = true
						break
					}
				}
				if hasInfo {
					break
				}
			}

			require.True(t, hasInfo)
		}

		require.NoError(t, rsp.Error)

		fname := name + "-frame"
		experimental.CheckGoldenJSONResponse(t, "testdata", fname, &rsp, update)
	}
}

func TestTimeConversions(t *testing.T) {
	// include millisecond precision
	assert.Equal(t,
		time.Date(2020, time.September, 14, 15, 22, 25, 479000000, time.UTC),
		timeFromFloat(1600096945.479))

	ti, err := timeFromLokiString("1645030246277587968")
	require.NoError(t, err)
	// Loki date parsing
	assert.Equal(t,
		time.Date(2022, time.February, 16, 16, 50, 46, 277587968, time.UTC),
		ti)

	ti, err = timeFromLokiString("2000000000000000000")
	require.NoError(t, err)

	assert.Equal(t,
		time.Date(2033, time.May, 18, 3, 33, 20, 0, time.UTC),
		ti)
}

func TestReadPrometheusNumericStrings(t *testing.T) {
	t.Run("matrix", func(t *testing.T) {
		input := []byte(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1,"1.25"],[2,"1.25e10"],[3,"NaN"],[4,"+Inf"],[5,"-Inf"]]}]}}`)
		rsp := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{})
		require.NoError(t, rsp.Error)
		require.Len(t, rsp.Frames, 1)
		assertNumericStringValues(t, rsp.Frames[0].Fields[1])
	})

	t.Run("exemplars", func(t *testing.T) {
		input := []byte(`{"status":"success","data":[{"seriesLabels":{},"exemplars":[{"value":"1.25","timestamp":1},{"value":"1.25e10","timestamp":2},{"value":"NaN","timestamp":3},{"value":"+Inf","timestamp":4},{"value":"-Inf","timestamp":5}]}]}`)
		rsp := ReadPrometheusStyleResult(jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, input), Options{})
		require.NoError(t, rsp.Error)
		require.Len(t, rsp.Frames, 1)
		assertNumericStringValues(t, rsp.Frames[0].Fields[1])
	})
}

func assertNumericStringValues(t *testing.T, field *data.Field) {
	t.Helper()
	require.Equal(t, 5, field.Len())
	assert.Equal(t, 1.25, field.At(0))
	assert.Equal(t, 1.25e10, field.At(1))
	assert.True(t, math.IsNaN(field.At(2).(float64)))
	assert.Equal(t, math.Inf(1), field.At(3))
	assert.Equal(t, math.Inf(-1), field.At(4))
}
