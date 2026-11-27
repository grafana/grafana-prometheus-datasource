package querydata_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/datasourcetest"
	"github.com/grafana/grafana-plugin-sdk-go/genproto/pluginv2"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// chunkFormats are the formats that a receiver can request. The query service requests JSON.
var chunkFormats = []struct {
	name   string
	format backend.DataFrameFormat
}{{"arrow", backend.DataFrameFormat_ARROW}, {"json", backend.DataFrameFormat_JSON}}

// recordingChunkedWriter records the chunks of the SDK writer, as the plugin sends them to Grafana.
type recordingChunkedWriter struct {
	backend.ChunkedDataWriter
	format backend.DataFrameFormat
	chunks []*pluginv2.QueryChunkedDataResponse
}

func newRecordingChunkedWriter(format backend.DataFrameFormat) *recordingChunkedWriter {
	w := &recordingChunkedWriter{format: format}
	w.ChunkedDataWriter = backend.NewChunkedDataWriter(format, func(c *pluginv2.QueryChunkedDataResponse) error {
		w.chunks = append(w.chunks, c)
		return nil
	})
	return w
}

func (w *recordingChunkedWriter) frameIDs(refID string) []string {
	var ids []string
	for _, c := range w.chunks {
		if c.RefId == refID && len(c.Frame) > 0 {
			ids = append(ids, c.FrameId)
		}
	}
	return ids
}

// accumulate joins the chunks with the frame ID rule, as Grafana does.
func (w *recordingChunkedWriter) accumulate(t *testing.T) backend.Responses {
	t.Helper()
	accumulate := datasourcetest.AccumulateArrow
	if w.format == backend.DataFrameFormat_JSON {
		accumulate = datasourcetest.AccumulateJSON
	}
	rsp, err := accumulate(func(yield func(*pluginv2.QueryChunkedDataResponse, error) bool) {
		for _, c := range w.chunks {
			if !yield(c, nil) {
				return
			}
		}
	})
	require.NoError(t, err)
	return rsp.Responses
}

// asReceived gives the frames of QueryData as a receiver decodes them from the format.
func asReceived(t *testing.T, format backend.DataFrameFormat, refID string, frames data.Frames) data.Frames {
	t.Helper()
	w := newRecordingChunkedWriter(format)
	for i, f := range frames {
		require.NoError(t, w.WriteFrame(context.Background(), refID, strconv.Itoa(i), f))
	}
	return w.accumulate(t)[refID].Frames
}

// requireSameFrames compares the frames by their JSON, which treats NaN and Inf values as equal.
func requireSameFrames(t *testing.T, expected, actual data.Frames) {
	t.Helper()
	e, err := json.Marshal(expected)
	require.NoError(t, err)
	a, err := json.Marshal(actual)
	require.NoError(t, err)
	require.Equal(t, string(e), string(a))
}

// fixture is a Prometheus HTTP response that the fake transport can send more than once.
type fixture struct {
	status int
	body   string
	header http.Header
}

func (f fixture) response() *http.Response {
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     f.header,
		Body:       io.NopCloser(bytes.NewReader([]byte(f.body))),
	}
}

// fixtures maps a Prometheus API path, for example /api/v1/query_range, to its response.
type fixtures map[string]fixture

func readFixture(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Clean(path))
	require.NoError(t, err)
	return string(b)
}

// sameResponse answers the range and the instant request with the same body.
func sameResponse(body string) fixtures {
	return fixtures{
		"/api/v1/query_range": {body: body},
		"/api/v1/query":       {body: body},
	}
}

func promQuery(t *testing.T, refID string, props models.PrometheusQueryProperties) backend.DataQuery {
	t.Helper()
	b, err := json.Marshal(models.QueryModel{PrometheusQueryProperties: props})
	require.NoError(t, err)
	return backend.DataQuery{
		RefID:     refID,
		JSON:      b,
		Interval:  15 * time.Second,
		TimeRange: backend.TimeRange{From: time.Unix(1641889530, 0), To: time.Unix(1641889830, 0)},
	}
}

func storedQuery(t *testing.T, name string) backend.DataQuery {
	t.Helper()
	req, err := loadStoredQuery(filepath.Join("../testdata", name+".query.json"))
	require.NoError(t, err)
	return req.Queries[0]
}

// runBothQueries runs the queries through Execute and ExecuteChunked against the same fixtures.
func runBothQueries(t *testing.T, fx fixtures, queries []backend.DataQuery, format backend.DataFrameFormat) (*backend.QueryDataResponse, *recordingChunkedWriter, error) {
	t.Helper()
	tctx, err := setup()
	require.NoError(t, err)
	tctx.httpProvider.roundTrip = func(req *http.Request) (*http.Response, error) {
		f, ok := fx[req.URL.Path]
		if !ok {
			return nil, fmt.Errorf("no fixture for %s", req.URL.Path)
		}
		return f.response(), nil
	}
	pluginCtx := backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(map[string]string{"concurrent_query_count": "10"})}
	ctx := context.Background()

	unary, err := tctx.queryData.Execute(ctx, &backend.QueryDataRequest{Queries: queries, PluginContext: pluginCtx})
	require.NoError(t, err)

	w := newRecordingChunkedWriter(format)
	err = tctx.queryData.ExecuteChunked(ctx, &backend.QueryChunkedDataRequest{Queries: queries, PluginContext: pluginCtx, Format: format}, w)
	return unary, w, err
}

// TestExecuteChunkedMatchesExecute makes sure that a receiver that joins the chunks gets the same frames as
// Execute returns, with one chunk for each frame.
func TestExecuteChunkedMatchesExecute(t *testing.T) {
	const converterData = "../converter/testdata/"
	rangeQuery := func(refID, legend string) backend.DataQuery {
		return promQuery(t, refID, models.PrometheusQueryProperties{Expr: "up", Range: true, LegendFormat: legend})
	}
	instantQuery := promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Instant: true})
	storedRange := func(name string) fixtures {
		return sameResponse(readFixture(t, filepath.Join("../testdata", name+".result.json")))
	}
	converterFixture := func(name string) fixtures {
		return sameResponse(readFixture(t, converterData+name+".json"))
	}

	cases := []struct {
		name    string
		fx      fixtures
		queries []backend.DataQuery
	}{
		{"range simple", storedRange("range_simple"), []backend.DataQuery{storedQuery(t, "range_simple")}},
		{"range missing", storedRange("range_missing"), []backend.DataQuery{storedQuery(t, "range_missing")}},
		{"range infinity", storedRange("range_infinity"), []backend.DataQuery{storedQuery(t, "range_infinity")}},
		{"range NaN", storedRange("range_nan"), []backend.DataQuery{storedQuery(t, "range_nan")}},
		{"range auto legend", storedRange("range_auto"), []backend.DataQuery{storedQuery(t, "range_auto")}},
		{"matrix", converterFixture("prom-matrix"), []backend.DataQuery{rangeQuery("A", "")}},
		{"big matrix", converterFixture("prom-query-range-big"), []backend.DataQuery{rangeQuery("A", "")}},
		{"matrix with NaN", converterFixture("prom-matrix-with-nans"), []backend.DataQuery{rangeQuery("A", "")}},
		{"vector", converterFixture("prom-vector"), []backend.DataQuery{instantQuery}},
		{"scalar", converterFixture("prom-scalar"), []backend.DataQuery{instantQuery}},
		{"string", converterFixture("prom-string"), []backend.DataQuery{instantQuery}},
		{"empty matrix", sameResponse(`{"status":"success","data":{"resultType":"matrix","result":[]}}`), []backend.DataQuery{rangeQuery("A", "")}},
		{"empty vector with warnings", converterFixture("prom-warnings-no-data"), []backend.DataQuery{instantQuery}},
		{"empty vector with infos", converterFixture("prom-infos-no-data"), []backend.DataQuery{instantQuery}},
		{"legend auto", converterFixture("prom-matrix"), []backend.DataQuery{rangeQuery("A", "__auto")}},
		{"legend template", converterFixture("prom-matrix"), []backend.DataQuery{rangeQuery("A", "{{job}} {{instance}}")}},
		{"two refIDs", converterFixture("prom-matrix"), []backend.DataQuery{rangeQuery("A", ""), rangeQuery("B", "{{job}}")}},
	}

	for _, cf := range chunkFormats {
		for _, tc := range cases {
			t.Run(cf.name+"/"+tc.name, func(t *testing.T) {
				unary, w, err := runBothQueries(t, tc.fx, tc.queries, cf.format)
				require.NoError(t, err)
				chunked := w.accumulate(t)

				for _, q := range tc.queries {
					expected := unary.Responses[q.RefID]
					require.NoError(t, expected.Error)
					require.NotEmpty(t, expected.Frames)
					actual := chunked[q.RefID]
					require.NoError(t, actual.Error)
					requireSameFrames(t, asReceived(t, cf.format, q.RefID, expected.Frames), actual.Frames)

					// The receiver joins chunks with the same frame ID, so one frame per chunk means that each
					// frame has an ID of its own.
					ids := w.frameIDs(q.RefID)
					require.Len(t, ids, len(actual.Frames), "one chunk per frame: %v", ids)
					for _, id := range ids {
						require.NotEmpty(t, id)
					}
				}
			})
		}
	}
}
