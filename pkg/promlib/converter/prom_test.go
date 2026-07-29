package converter

import (
	"os"
	"path"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
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

func TestReadPrometheusQueryStats(t *testing.T) {
	read := func(t *testing.T, payload string) *backend.DataResponse {
		t.Helper()
		iter := jsoniter.ParseBytes(sdkjsoniter.ConfigDefault, []byte(payload))
		rsp := ReadPrometheusStyleResult(iter, Options{})
		require.NoError(t, rsp.Error)
		return &rsp
	}

	instantResult := `[{"metric":{"__name__":"up","instance":"localhost"},"value":[1710000000,"1"]}]`
	perStep := `[[1710000000,12],[1710000060,18]]`

	for _, tc := range []struct {
		name string
		data string
	}{
		{
			name: "stats after result",
			data: `{"resultType":"vector","result":` + instantResult + `,"stats":{"samples":{"totalQueryableSamples":30,"totalQueryableSamplesPerStep":` + perStep + `}}}`,
		},
		{
			name: "stats before result",
			data: `{"stats":{"samples":{"totalQueryableSamples":30,"totalQueryableSamplesPerStep":` + perStep + `}},"resultType":"vector","result":` + instantResult + `}`,
		},
		{
			name: "stats and result before result type",
			data: `{"stats":{"samples":{"totalQueryableSamples":30,"totalQueryableSamplesPerStep":` + perStep + `}},"result":` + instantResult + `,"resultType":"vector"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rsp := read(t, `{"status":"success","data":`+tc.data+`}`)
			require.Len(t, rsp.Frames, 1)
			require.NotNil(t, rsp.Frames[0].Meta)
			require.Equal(t, []data.QueryStat{{
				FieldConfig: data.FieldConfig{DisplayName: "Total queryable samples"},
				Value:       30,
			}}, rsp.Frames[0].Meta.Stats)

			custom, ok := rsp.Frames[0].Meta.Custom.(map[string]any)
			require.True(t, ok)
			require.Equal(t, "vector", custom["resultType"])
			rawStats, ok := custom["stats"].(map[string]any)
			require.True(t, ok)
			samples, ok := rawStats["samples"].(map[string]any)
			require.True(t, ok)
			require.Equal(t, float64(30), samples["totalQueryableSamples"])
			require.Len(t, samples["totalQueryableSamplesPerStep"], 2)
		})
	}

	t.Run("zero samples is retained as a typed stat", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"vector","result":[],"stats":{"samples":{"totalQueryableSamples":0}}}}`)
		require.Len(t, rsp.Frames, 1)
		require.Len(t, rsp.Frames[0].Meta.Stats, 1)
		require.Equal(t, float64(0), rsp.Frames[0].Meta.Stats[0].Value)
	})

	t.Run("range stats are attached to the first frame only", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"one"},"values":[[1710000000,"1"]]},{"metric":{"job":"two"},"values":[[1710000000,"2"]]}],"stats":{"samples":{"totalQueryableSamples":2}}}}`)
		require.Len(t, rsp.Frames, 2)
		require.Len(t, rsp.Frames[0].Meta.Stats, 1)
		require.Empty(t, rsp.Frames[1].Meta.Stats)
	})

	t.Run("empty result creates a metadata-only frame", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"matrix","result":[],"stats":{"samples":{"totalQueryableSamples":7}}}}`)
		require.Len(t, rsp.Frames, 1)
		require.Equal(t, "Query statistics", rsp.Frames[0].Name)
		require.Empty(t, rsp.Frames[0].Fields)
		require.Equal(t, float64(7), rsp.Frames[0].Meta.Stats[0].Value)
	})

	t.Run("malformed stats do not fail a valid query", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"vector","result":`+instantResult+`,"stats":"not-an-object"}}`)
		require.Len(t, rsp.Frames, 1)
		require.Empty(t, rsp.Frames[0].Meta.Stats)
		custom := rsp.Frames[0].Meta.Custom.(map[string]any)
		require.Equal(t, "not-an-object", custom["stats"])
	})

	t.Run("malformed total omits only the typed stat", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"vector","result":`+instantResult+`,"stats":{"samples":{"totalQueryableSamples":"unknown","totalQueryableSamplesPerStep":`+perStep+`}}}}`)
		require.Empty(t, rsp.Frames[0].Meta.Stats)
		custom := rsp.Frames[0].Meta.Custom.(map[string]any)
		require.NotNil(t, custom["stats"])
	})

	t.Run("missing stats leaves existing metadata unchanged", func(t *testing.T) {
		rsp := read(t, `{"status":"success","data":{"resultType":"vector","result":`+instantResult+`}}`)
		require.Empty(t, rsp.Frames[0].Meta.Stats)
		require.Equal(t, map[string]any{"resultType": "vector"}, rsp.Frames[0].Meta.Custom)
	})
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
