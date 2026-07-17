package querydata

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
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
