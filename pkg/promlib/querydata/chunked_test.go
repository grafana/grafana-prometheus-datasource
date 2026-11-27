package querydata_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
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
	panics bool // the body panics on read
}

func (f fixture) response() *http.Response {
	status := f.status
	if status == 0 {
		status = http.StatusOK
	}
	var body io.ReadCloser = io.NopCloser(bytes.NewReader([]byte(f.body)))
	if f.panics {
		body = panickingBody{}
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     f.header,
		Body:       body,
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

func promQuery(t testing.TB, refID string, props models.PrometheusQueryProperties) backend.DataQuery {
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
		{
			"one series with notices",
			sameResponse(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1641889530,"1"]}]},"warnings":["w"],"infos":["i"]}`),
			[]backend.DataQuery{instantQuery},
		},
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

// requireSameError makes sure that the receiver gets the error of Execute, with its status and error source. The
// receiver reads an error without a status as 500.
func requireSameError(t *testing.T, expected, actual backend.DataResponse) {
	t.Helper()
	require.Error(t, expected.Error)
	require.Error(t, actual.Error)
	require.Equal(t, expected.Error.Error(), actual.Error.Error())
	status := expected.Status
	if status == 0 {
		status = backend.StatusInternal
	}
	require.Equal(t, status, actual.Status)
	// The SDK error source middleware gives a QueryData error without a source the downstream source when the error
	// is a downstream error. The writer takes the source from the error too.
	source := expected.ErrorSource
	if source == "" && backend.IsDownstreamError(expected.Error) {
		source = backend.ErrorSourceDownstream
	}
	require.Equal(t, source, actual.ErrorSource)
}

// TestExecuteChunkedErrorsMatchExecute makes sure that a receiver gets the same error and frames as Execute returns.
func TestExecuteChunkedErrorsMatchExecute(t *testing.T) {
	matrix := readFixture(t, "../converter/testdata/prom-matrix.json")
	promError := readFixture(t, "../converter/testdata/prom-error.json")
	rangeQuery := promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true})
	statusError := func(status int) fixtures {
		return fixtures{"/api/v1/query_range": {status: status, body: promError}}
	}

	cases := []struct {
		name    string
		fx      fixtures
		queries []backend.DataQuery
	}{
		{"query model does not parse", sameResponse(matrix), []backend.DataQuery{{RefID: "A", JSON: []byte(`{`)}}},
		{"HTTP request fails", fixtures{}, []backend.DataQuery{rangeQuery}},
		{"Prometheus error with 400", statusError(http.StatusBadRequest), []backend.DataQuery{rangeQuery}},
		{"Prometheus error with 422", statusError(http.StatusUnprocessableEntity), []backend.DataQuery{rangeQuery}},
		{"Prometheus error with 503", statusError(http.StatusServiceUnavailable), []backend.DataQuery{rangeQuery}},
		{"unknown status code", fixtures{"/api/v1/query_range": {status: http.StatusInternalServerError, body: "<html>oops</html>"}}, []backend.DataQuery{rangeQuery}},
		{
			"range fails, instant works",
			fixtures{"/api/v1/query": {body: readFixture(t, "../converter/testdata/prom-vector.json")}},
			[]backend.DataQuery{promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true, Instant: true})},
		},
		{
			"a panic fails only its query",
			fixtures{"/api/v1/query_range": {panics: true}, "/api/v1/query": {body: readFixture(t, "../converter/testdata/prom-vector.json")}},
			[]backend.DataQuery{rangeQuery, promQuery(t, "B", models.PrometheusQueryProperties{Expr: "up", Instant: true})},
		},
	}

	for _, cf := range chunkFormats {
		for _, tc := range cases {
			t.Run(cf.name+"/"+tc.name, func(t *testing.T) {
				unary, w, err := runBothQueries(t, tc.fx, tc.queries, cf.format)
				require.NoError(t, err)
				chunked := w.accumulate(t)

				for _, q := range tc.queries {
					expected := unary.Responses[q.RefID]
					actual := chunked[q.RefID]
					if expected.Error == nil {
						require.NoError(t, actual.Error)
					} else {
						requireSameError(t, expected, actual)
					}
					requireSameFrames(t, asReceived(t, cf.format, q.RefID, expected.Frames), actual.Frames)
				}
			})
		}
	}
}

// TestExecuteChunkedJoinsTheRangeAndInstantErrors covers a query whose two requests fail. Execute runs them at the
// same time, so the order of the errors and the status change from run to run. ExecuteChunked runs the range
// request first, so the instant request gives the status.
func TestExecuteChunkedJoinsTheRangeAndInstantErrors(t *testing.T) {
	fx := fixtures{"/api/v1/query_range": {status: http.StatusBadRequest, body: readFixture(t, "../converter/testdata/prom-error.json")}}
	query := []backend.DataQuery{promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true, Instant: true})}
	rangeErr := `bad_data: invalid parameter "start": cannot parse "" to a valid timestamp`
	instantErr := `Post "http://localhost:9090/api/v1/query": no fixture for /api/v1/query`

	for _, cf := range chunkFormats {
		t.Run(cf.name, func(t *testing.T) {
			unary, w, err := runBothQueries(t, fx, query, cf.format)
			require.NoError(t, err)
			expected := unary.Responses["A"]
			actual := w.accumulate(t)["A"]

			require.Contains(t, []string{rangeErr + " " + instantErr, instantErr + " " + rangeErr}, expected.Error.Error())
			require.EqualError(t, actual.Error, rangeErr+" "+instantErr)
			require.Equal(t, backend.StatusBadGateway, actual.Status)
			require.Equal(t, backend.ErrorSourceDownstream, actual.ErrorSource)
			requireSameFrames(t, asReceived(t, cf.format, "A", expected.Frames), actual.Frames)
		})
	}
}

// TestExecuteChunkedKeepsTheSeriesBeforeAParseError covers a body that ends in the third series. Execute drops the
// two series that it read. The series that ExecuteChunked wrote stay, and the error is the same.
func TestExecuteChunkedKeepsTheSeriesBeforeAParseError(t *testing.T) {
	body := readFixture(t, "../converter/testdata/prom-query-range-big.json")
	third := 0
	for range 3 {
		third += strings.Index(body[third:], `"metric"`) + 1
	}
	truncated := sameResponse(body[:third+100])
	query := []backend.DataQuery{promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true})}

	for _, cf := range chunkFormats {
		t.Run(cf.name, func(t *testing.T) {
			full, _, err := runBothQueries(t, sameResponse(body), query, cf.format)
			require.NoError(t, err)
			unary, w, err := runBothQueries(t, truncated, query, cf.format)
			require.NoError(t, err)
			actual := w.accumulate(t)["A"]

			requireSameError(t, unary.Responses["A"], actual)
			requireSameFrames(t, asReceived(t, cf.format, "A", full.Responses["A"].Frames[:2]), actual.Frames)
		})
	}
}

// TestExecuteChunkedReturnsTheFirstWriteError makes sure that a failed write ends the request. The writer gets no
// more chunks, the method returns the write error, and the second query does not run.
func TestExecuteChunkedReturnsTheFirstWriteError(t *testing.T) {
	tctx, err := setup()
	require.NoError(t, err)
	requests := 0
	tctx.httpProvider.roundTrip = func(*http.Request) (*http.Response, error) {
		requests++
		return fixture{body: readFixture(t, "../converter/testdata/prom-query-range-big.json")}.response(), nil
	}
	queries := []backend.DataQuery{
		promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true}),
		promQuery(t, "B", models.PrometheusQueryProperties{Expr: "up", Range: true}),
	}

	sendErr := errors.New("send failed")
	writes := 0
	w := backend.NewChunkedDataWriter(backend.DataFrameFormat_JSON, func(*pluginv2.QueryChunkedDataResponse) error {
		writes++
		return sendErr
	})

	err = tctx.queryData.ExecuteChunked(context.Background(), &backend.QueryChunkedDataRequest{Queries: queries}, w)
	require.ErrorIs(t, err, sendErr)
	require.Equal(t, 1, writes, "no write after the failed write")
	require.Equal(t, 1, requests, "the second query does not run")
}

func TestExecuteChunkedStopsWhenTheContextIsCancelled(t *testing.T) {
	tctx, err := setup()
	require.NoError(t, err)
	requests := 0
	tctx.httpProvider.roundTrip = func(*http.Request) (*http.Response, error) {
		requests++
		return fixture{body: readFixture(t, "../converter/testdata/prom-matrix.json")}.response(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	w := newRecordingChunkedWriter(backend.DataFrameFormat_JSON)
	err = tctx.queryData.ExecuteChunked(ctx, &backend.QueryChunkedDataRequest{
		Queries: []backend.DataQuery{promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true})},
	}, w)
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, w.chunks)
	require.Zero(t, requests)
}

// exemplarsLast puts the exemplar frame after the other frames. Execute runs the exemplar request at the same time
// as the range request, so its frame can come first.
func exemplarsLast(frames data.Frames) data.Frames {
	var others, exemplars data.Frames
	for _, f := range frames {
		if f.Name == "exemplar" {
			exemplars = append(exemplars, f)
		} else {
			others = append(others, f)
		}
	}
	return append(others, exemplars...)
}

func TestExecuteChunkedExemplars(t *testing.T) {
	exemplars := readFixture(t, "../testdata/exemplar.result.json")
	matrix := readFixture(t, "../converter/testdata/prom-matrix.json")
	rangeAndExemplar := promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Range: true, Exemplar: true})

	cases := []struct {
		name    string
		fx      fixtures
		queries []backend.DataQuery
	}{
		// models.Parse turns on the range request when neither range nor instant is set.
		{"exemplar query", fixtures{"/api/v1/query_range": {body: matrix}, "/api/v1/query_exemplars": {body: exemplars}}, []backend.DataQuery{storedQuery(t, "exemplar")}},
		{"range and exemplar query", fixtures{"/api/v1/query_range": {body: matrix}, "/api/v1/query_exemplars": {body: exemplars}}, []backend.DataQuery{rangeAndExemplar}},
		{"failed exemplar request", fixtures{"/api/v1/query_range": {body: matrix}}, []backend.DataQuery{rangeAndExemplar}},
	}

	for _, cf := range chunkFormats {
		for _, tc := range cases {
			t.Run(cf.name+"/"+tc.name, func(t *testing.T) {
				unary, w, err := runBothQueries(t, tc.fx, tc.queries, cf.format)
				require.NoError(t, err)
				expected := unary.Responses["A"]
				actual := w.accumulate(t)["A"]
				require.NoError(t, expected.Error)
				require.NoError(t, actual.Error)
				requireSameFrames(t, asReceived(t, cf.format, "A", exemplarsLast(expected.Frames)), actual.Frames)
				require.Len(t, w.frameIDs("A"), len(actual.Frames), "one chunk per frame")
			})
		}
	}
}

// TestExecuteChunkedPutsTheNoticesOnTheLastSeries covers the warnings and infos. They come after the result in the
// Prometheus response, so ExecuteChunked puts them on the last series, and Execute puts them on every series.
// Grafana shows the notices of all frames without duplicates, so users see the same notices.
func TestExecuteChunkedPutsTheNoticesOnTheLastSeries(t *testing.T) {
	query := []backend.DataQuery{promQuery(t, "A", models.PrometheusQueryProperties{Expr: "up", Instant: true})}
	for _, cf := range chunkFormats {
		for _, name := range []string{"prom-warnings", "prom-infos"} {
			t.Run(cf.name+"/"+name, func(t *testing.T) {
				fx := sameResponse(readFixture(t, "../converter/testdata/"+name+".json"))
				unary, w, err := runBothQueries(t, fx, query, cf.format)
				require.NoError(t, err)
				expected := asReceived(t, cf.format, "A", unary.Responses["A"].Frames)
				actual := w.accumulate(t)["A"].Frames
				require.Len(t, actual, len(expected))
				require.Greater(t, len(actual), 1)

				notices := expected[0].Meta.Notices
				require.NotEmpty(t, notices)
				for i := range actual {
					require.Equal(t, notices, expected[i].Meta.Notices)
					if i == len(actual)-1 {
						require.Equal(t, notices, actual[i].Meta.Notices)
					} else {
						require.Empty(t, actual[i].Meta.Notices)
					}
					// The rest of the metadata is the same.
					expected[i].Meta.Notices = nil
					actual[i].Meta.Notices = nil
				}
				requireSameFrames(t, expected, actual)
			})
		}
	}
}
