package querydata

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/backend/tracing"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/datasourcetest"
	"github.com/grafana/grafana-plugin-sdk-go/genproto/pluginv2"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/client"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/intervalv2"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata/exemplar"
)

type recordedChunk struct {
	refID   string
	frameID string
	frame   *data.Frame
}

type recordingChunkWriter struct {
	chunks   []recordedChunk
	errors   []error
	writeErr error
}

func (w *recordingChunkWriter) WriteFrame(_ context.Context, refID, frameID string, frame *data.Frame) error {
	if w.writeErr != nil {
		return w.writeErr
	}
	w.chunks = append(w.chunks, recordedChunk{refID: refID, frameID: frameID, frame: frame})
	return nil
}

func (w *recordingChunkWriter) WriteError(_ context.Context, _ string, _ backend.Status, err error) error {
	w.errors = append(w.errors, err)
	return nil
}

func TestQueryDataStreamMatrixSplitsOneSeriesWithoutChangingFrameSchema(t *testing.T) {
	var samples strings.Builder
	for i := range chunkSampleLimit + 1 {
		if i > 0 {
			samples.WriteByte(',')
		}
		fmt.Fprintf(&samples, "[%d,\"%d\"]", i, i)
	}
	body := fmt.Sprintf(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up","job":"prometheus"},"values":[%s]}]}}`, samples.String())
	writer := &recordingChunkWriter{}
	query := &models.Query{RefId: "A", Expr: "up", Step: time.Second, RangeQuery: true}

	err := (&QueryData{}).streamMatrix(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}, writer)

	require.NoError(t, err)
	require.Len(t, writer.chunks, 2)
	require.Equal(t, "A", writer.chunks[0].refID)
	require.Equal(t, "range/0", writer.chunks[0].frameID)
	require.Equal(t, writer.chunks[0].frameID, writer.chunks[1].frameID)
	require.Equal(t, chunkSampleLimit, writer.chunks[0].frame.Fields[0].Len())
	require.Equal(t, 1, writer.chunks[1].frame.Fields[0].Len())
	require.Equal(t, writer.chunks[0].frame.Fields[0].Name, writer.chunks[1].frame.Fields[0].Name)
	require.Equal(t, writer.chunks[0].frame.Fields[1].Labels, writer.chunks[1].frame.Fields[1].Labels)
	require.Equal(t, "Expr: up\nStep: 1s", writer.chunks[0].frame.Meta.ExecutedQueryString)
	require.Equal(t, int64(1000), writer.chunks[0].frame.Meta.Custom.(map[string]any)["calculatedMinStep"])
}

func TestQueryDataStreamMatrixRejectsNoncanonicalAndTruncatedResponses(t *testing.T) {
	query := &models.Query{RefId: "A", RangeQuery: true}
	for _, body := range []string{
		`{"data":{"resultType":"matrix","result":[]}}`,
		`{"status":"success","data":{"resultType":"matrix","result":[`,
	} {
		t.Run(body[:10], func(t *testing.T) {
			err := (&QueryData{}).streamMatrix(context.Background(), query, &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(body)),
			}, &recordingChunkWriter{})
			require.Error(t, err)
		})
	}
}

func TestQueryDataStreamMatrixStopsWhenWriterOrContextFails(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[1,"1"]]}]}}`
	query := &models.Query{RefId: "A", RangeQuery: true}

	t.Run("writer failure", func(t *testing.T) {
		expected := fmt.Errorf("client disconnected")
		err := (&QueryData{}).streamMatrix(context.Background(), query, &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
		}, &recordingChunkWriter{writeErr: expected})
		require.ErrorIs(t, err, expected)
	})

	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		err := (&QueryData{}).streamMatrix(ctx, query, &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
		}, &recordingChunkWriter{})
		require.ErrorIs(t, err, context.Canceled)
	})
}

func TestQueryDataExecuteChunkedDoesNotCallUpstreamForInstantOrExemplarQueries(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
		t.Fatal("unsupported query reached the chunked upstream path")
	}))
	defer server.Close()

	queryData := &QueryData{
		intervalCalculator: intervalv2.NewCalculator(),
		tracer:             tracing.DefaultTracer(),
		client:             client.NewClient(server.Client(), http.MethodGet, server.URL, ""),
		log:                log.New(),
		TimeInterval:       "15s",
	}
	writer := &recordingChunkWriter{}
	request := &backend.QueryChunkedDataRequest{
		Queries: []backend.DataQuery{
			{
				RefID:     "instant",
				TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)},
				Interval:  time.Second,
				JSON:      []byte(`{"expr":"up","instant":true,"intervalMs":1000}`),
			},
			{
				RefID:     "exemplar",
				TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)},
				Interval:  time.Second,
				JSON:      []byte(`{"expr":"up","range":true,"exemplar":true,"intervalMs":1000}`),
			},
		},
	}

	err := queryData.ExecuteChunked(context.Background(), request, writer)

	require.NoError(t, err)
	require.Zero(t, requests)
	require.Len(t, writer.errors, 2)
	require.ErrorContains(t, writer.errors[0], "range queries only")
	require.ErrorContains(t, writer.errors[1], "do not support exemplars")
}

func TestQueryDataExecuteChunkedKeepsRangeQueryRefIDsSeparate(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		requests++
		_, err := io.WriteString(response, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[1,"1"]]}]}}`)
		require.NoError(t, err)
	}))
	defer server.Close()

	queryData := &QueryData{
		intervalCalculator: intervalv2.NewCalculator(),
		tracer:             tracing.DefaultTracer(),
		client:             client.NewClient(server.Client(), http.MethodGet, server.URL, ""),
		log:                log.New(),
		TimeInterval:       "15s",
	}
	writer := &recordingChunkWriter{}
	request := &backend.QueryChunkedDataRequest{
		Queries: []backend.DataQuery{
			{
				RefID:     "A",
				TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)},
				Interval:  time.Second,
				JSON:      []byte(`{"expr":"up","range":true,"intervalMs":1000}`),
			},
			{
				RefID:     "B",
				TimeRange: backend.TimeRange{From: time.Unix(0, 0), To: time.Unix(60, 0)},
				Interval:  time.Second,
				JSON:      []byte(`{"expr":"up","range":true,"intervalMs":1000}`),
			},
		},
	}

	err := queryData.ExecuteChunked(context.Background(), request, writer)

	require.NoError(t, err)
	require.Equal(t, 2, requests)
	require.Len(t, writer.chunks, 2)
	require.Equal(t, "A", writer.chunks[0].refID)
	require.Equal(t, "B", writer.chunks[1].refID)
	require.Empty(t, writer.errors)
}

func TestQueryDataStreamMatrixMatchesBufferedResponseAfterJSONAccumulation(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up","job":"prometheus"},"values":[[1,"1"],[2,"2"]]},{"metric":{"__name__":"up","job":"node"},"values":[[1,"3"],[2,"4"]]}]}}`
	query := &models.Query{RefId: "A", Expr: "up", Step: time.Second, RangeQuery: true}
	queryData := &QueryData{
		tracer:          tracing.DefaultTracer(),
		log:             log.New(),
		exemplarSampler: exemplar.NewStandardDeviationSampler,
	}

	expected := queryData.parseResponse(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	})
	require.NoError(t, expected.Error)

	var chunks []*pluginv2.QueryChunkedDataResponse
	writer := backend.NewChunkedDataWriter(backend.DataFrameFormat_JSON, func(chunk *pluginv2.QueryChunkedDataResponse) error {
		chunks = append(chunks, chunk)
		return nil
	})
	err := queryData.streamMatrix(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, writer)
	require.NoError(t, err)

	accumulated, err := datasourcetest.AccumulateJSON(func(yield func(*pluginv2.QueryChunkedDataResponse, error) bool) {
		for _, chunk := range chunks {
			if !yield(chunk, nil) {
				return
			}
		}
	})
	require.NoError(t, err)

	normalizedExpectedFrames := make(data.Frames, 0, len(expected.Frames))
	for _, frame := range expected.Frames {
		frame.SetRefID("A")
		encoded, err := data.FrameToJSON(frame, data.IncludeAll)
		require.NoError(t, err)
		normalized := &data.Frame{}
		require.NoError(t, json.Unmarshal(encoded, normalized))
		normalizedExpectedFrames = append(normalizedExpectedFrames, normalized)
	}
	require.Equal(t, normalizedExpectedFrames, accumulated.Responses["A"].Frames)
}

func TestQueryDataStreamMatrixPreservesSpecialFloatValues(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[1,"NaN"],[2,"+Inf"],[3,"-Inf"]]}]}}`
	query := &models.Query{RefId: "A", Expr: "up", Step: time.Second, RangeQuery: true}
	queryData := &QueryData{
		tracer:          tracing.DefaultTracer(),
		log:             log.New(),
		exemplarSampler: exemplar.NewStandardDeviationSampler,
	}
	expected := queryData.parseResponse(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	})
	require.NoError(t, expected.Error)

	var chunks []*pluginv2.QueryChunkedDataResponse
	writer := backend.NewChunkedDataWriter(backend.DataFrameFormat_JSON, func(chunk *pluginv2.QueryChunkedDataResponse) error {
		chunks = append(chunks, chunk)
		return nil
	})
	require.NoError(t, queryData.streamMatrix(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, writer))
	accumulated, err := datasourcetest.AccumulateJSON(chunkSequence(chunks))
	require.NoError(t, err)

	expectedValues := expected.Frames[0].Fields[1]
	actualValues := accumulated.Responses["A"].Frames[0].Fields[1]
	require.Equal(t, expectedValues.Len(), actualValues.Len())
	for i := range expectedValues.Len() {
		require.Equal(t, math.Float64bits(expectedValues.At(i).(float64)), math.Float64bits(actualValues.At(i).(float64)))
	}
}

func TestQueryDataStreamMatrixMatchesBufferedEmptyResponse(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"matrix","result":[]}}`
	query := &models.Query{RefId: "A", Expr: "up", Step: time.Second, RangeQuery: true}
	queryData := &QueryData{
		tracer:          tracing.DefaultTracer(),
		log:             log.New(),
		exemplarSampler: exemplar.NewStandardDeviationSampler,
	}
	expected := queryData.parseResponse(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	})
	require.NoError(t, expected.Error)

	var chunks []*pluginv2.QueryChunkedDataResponse
	writer := backend.NewChunkedDataWriter(backend.DataFrameFormat_JSON, func(chunk *pluginv2.QueryChunkedDataResponse) error {
		chunks = append(chunks, chunk)
		return nil
	})
	require.NoError(t, queryData.streamMatrix(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, writer))
	accumulated, err := datasourcetest.AccumulateJSON(chunkSequence(chunks))
	require.NoError(t, err)
	require.Len(t, expected.Frames, 1)
	require.Len(t, accumulated.Responses["A"].Frames, 1)
	require.Empty(t, expected.Frames[0].Fields)
	require.Empty(t, accumulated.Responses["A"].Frames[0].Fields)
	require.Equal(t, expected.Frames[0].Meta.ExecutedQueryString, accumulated.Responses["A"].Frames[0].Meta.ExecutedQueryString)
}

func TestQueryDataStreamMatrixRejectsNativeHistogramResults(t *testing.T) {
	body := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"histograms":[[1,{"count":"1","sum":"1","buckets":[]}]]}]}}`
	query := &models.Query{RefId: "A", RangeQuery: true}

	err := (&QueryData{}).streamMatrix(context.Background(), query, &http.Response{
		StatusCode: http.StatusOK,
		Body:       io.NopCloser(strings.NewReader(body)),
	}, &recordingChunkWriter{})

	require.ErrorContains(t, err, "do not support histogram")
}

func chunkSequence(chunks []*pluginv2.QueryChunkedDataResponse) func(func(*pluginv2.QueryChunkedDataResponse, error) bool) {
	return func(yield func(*pluginv2.QueryChunkedDataResponse, error) bool) {
		for _, chunk := range chunks {
			if !yield(chunk, nil) {
				return
			}
		}
	}
}
