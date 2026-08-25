package querydata

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/querydata/exemplar"
)

func TestQueryData_parseResponse(t *testing.T) {
	qd := QueryData{exemplarSampler: exemplar.NewStandardDeviationSampler}

	t.Run("resultType is before result the field must parsed normally", func(t *testing.T) {
		resBody := `{"data":{"resultType":"vector", "result":[{"metric":{"__name__":"some_name","environment":"some_env","id":"some_id","instance":"some_instance:1234","job":"some_job","name":"another_name","region":"some_region"},"value":[1.1,"2"]}]},"status":"success"}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Nil(t, result.Error)
		assert.Len(t, result.Frames, 1)
	})

	t.Run("resultType is after the result field must parsed normally", func(t *testing.T) {
		resBody := `{"data":{"result":[{"metric":{"__name__":"some_name","environment":"some_env","id":"some_id","instance":"some_instance:1234","job":"some_job","name":"another_name","region":"some_region"},"value":[1.1,"2"]}],"resultType":"vector"},"status":"success"}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Nil(t, result.Error)
		assert.Len(t, result.Frames, 1)
	})

	t.Run("no resultType is existed in the data", func(t *testing.T) {
		resBody := `{"data":{"result":[{"metric":{"__name__":"some_name","environment":"some_env","id":"some_id","instance":"some_instance:1234","job":"some_job","name":"another_name","region":"some_region"},"value":[1.1,"2"]}]},"status":"success"}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Error(t, result.Error)
		assert.Equal(t, result.Error.Error(), "no resultType found")
	})

	t.Run("resultType is set as empty string before result", func(t *testing.T) {
		resBody := `{"data":{"resultType":"", "result":[{"metric":{"__name__":"some_name","environment":"some_env","id":"some_id","instance":"some_instance:1234","job":"some_job","name":"another_name","region":"some_region"},"value":[1.1,"2"]}]},"status":"success"}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Error(t, result.Error)
		assert.Equal(t, result.Error.Error(), "unknown result type: ")
	})

	t.Run("resultType is set as empty string after result", func(t *testing.T) {
		resBody := `{"data":{"result":[{"metric":{"__name__":"some_name","environment":"some_env","id":"some_id","instance":"some_instance:1234","job":"some_job","name":"another_name","region":"some_region"},"value":[1.1,"2"]}],"resultType":""},"status":"success"}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Error(t, result.Error)
		assert.Equal(t, result.Error.Error(), "unknown result type: ")
	})
}

func TestAddMetadataToMultiFrame(t *testing.T) {
	t.Run("when you have native histogram result", func(t *testing.T) {
		qd := QueryData{exemplarSampler: exemplar.NewStandardDeviationSampler}
		resBody := `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"rpc_durations_native_histogram_seconds","instance":"nativehisto:8080","job":"prometheus"},"histograms":[[1729529685,{"count":"7243102","sum":"72460202.93145595","buckets":[[0,"1.8340080864093422","2","10"],[0,"2","2.1810154653305154","68"]]}],[1729529700,{"count":"7243490","sum":"72464056.03309634","buckets":[[0,"1.8340080864093422","2","10"],[0,"2","2.1810154653305154","68"]]}],[1729529715,{"count":"7243880","sum":"72467935.35871512","buckets":[[0,"1.8340080864093422","2","10"],[0,"2","2.1810154653305154","68"]]}]]}]}}`
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		assert.Nil(t, result.Error)
		assert.Len(t, result.Frames, 1)
		assert.Equal(t, "yMin", result.Frames[0].Fields[1].Name)
	})
}

func TestParseQueryStats(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   []data.QueryStat
	}{
		{
			name:   "absent header",
			header: "",
			want:   nil,
		},
		{
			name:   "all known Mimir metrics",
			header: "bytes_processed;val=11188007, equivalent_samples_read;val=20000, querier_wall_time;dur=5215.074756, response_time;dur=1061.890603, samples_processed;val=17647",
			want: []data.QueryStat{
				{FieldConfig: data.FieldConfig{DisplayName: "Bytes processed", Unit: "decbytes"}, Value: 11188007},
				{FieldConfig: data.FieldConfig{DisplayName: "Equivalent samples read", Unit: "short"}, Value: 20000},
				{FieldConfig: data.FieldConfig{DisplayName: "Querier wall time", Unit: "ms"}, Value: 5215.074756},
				{FieldConfig: data.FieldConfig{DisplayName: "Response time", Unit: "ms"}, Value: 1061.890603},
				{FieldConfig: data.FieldConfig{DisplayName: "Samples processed", Unit: "short"}, Value: 17647},
			},
		},
		{
			name:   "unknown metrics are skipped",
			header: "future_metric;val=42, bytes_processed;val=11188007",
			want: []data.QueryStat{
				{FieldConfig: data.FieldConfig{DisplayName: "Bytes processed", Unit: "decbytes"}, Value: 11188007},
			},
		},
		{
			name:   "malformed entries are skipped",
			header: "querier_wall_time, bytes_processed;val=notanumber, response_time;dur=10",
			want: []data.QueryStat{
				{FieldConfig: data.FieldConfig{DisplayName: "Response time", Unit: "ms"}, Value: 10},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			header := http.Header{}
			if tt.header != "" {
				header.Set("Server-Timing", tt.header)
			}
			assert.Equal(t, tt.want, parseQueryStats(header))
		})
	}
}

func TestParseResponse_QueryStats(t *testing.T) {
	qd := QueryData{exemplarSampler: exemplar.NewStandardDeviationSampler}
	resBody := `{"data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1.1,"2"]}]},"status":"success"}`

	t.Run("populates frame meta stats from Server-Timing header", func(t *testing.T) {
		res := &http.Response{
			Body:       io.NopCloser(bytes.NewBufferString(resBody)),
			StatusCode: 200,
			Header:     http.Header{"Server-Timing": []string{"equivalent_samples_read;val=20000"}},
		}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		require.Nil(t, result.Error)
		require.Len(t, result.Frames, 1)
		assert.Equal(t, []data.QueryStat{
			{FieldConfig: data.FieldConfig{DisplayName: "Equivalent samples read", Unit: "short"}, Value: 20000},
		}, result.Frames[0].Meta.Stats)
	})

	t.Run("leaves stats nil when header absent", func(t *testing.T) {
		res := &http.Response{Body: io.NopCloser(bytes.NewBufferString(resBody)), StatusCode: 200}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		require.Nil(t, result.Error)
		require.Len(t, result.Frames, 1)
		assert.Nil(t, result.Frames[0].Meta.Stats)
	})

	t.Run("keeps Prometheus's own stats alongside Server-Timing stats", func(t *testing.T) {
		bodyWithStats := `{"data":{"resultType":"vector","result":[{"metric":{"__name__":"up"},"value":[1.1,"2"]}],"stats":{"samples":{"totalQueryableSamples":30}}},"status":"success"}`
		res := &http.Response{
			Body:       io.NopCloser(bytes.NewBufferString(bodyWithStats)),
			StatusCode: 200,
			Header:     http.Header{"Server-Timing": []string{"equivalent_samples_read;val=20000"}},
		}
		result := qd.parseResponse(context.Background(), &models.Query{}, res)
		require.Nil(t, result.Error)
		require.Len(t, result.Frames, 1)
		assert.Equal(t, []data.QueryStat{
			{FieldConfig: data.FieldConfig{DisplayName: "Total queryable samples"}, Value: 30},
			{FieldConfig: data.FieldConfig{DisplayName: "Equivalent samples read", Unit: "short"}, Value: 20000},
		}, result.Frames[0].Meta.Stats)
	})
}

// Helper function to create mock HTTP response.
func createMockResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Body:       io.NopCloser(bytes.NewReader([]byte(body))),
	}
}

func TestParseResponse_ErrorCases(t *testing.T) {
	ctx := context.Background()

	tests := []struct {
		name       string
		statusCode int
		body       string
	}{
		{"500 Internal Server Error", http.StatusInternalServerError, `{"error":"internal server error"}`},
		{"404 Not Found", http.StatusNotFound, `{"error":"not found"}`},
		{"401 Unauthorized", http.StatusUnauthorized, `{"error":"unauthorized"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := createMockResponse(tt.statusCode, tt.body)
			q := &models.Query{}
			qd := QueryData{exemplarSampler: exemplar.NewStandardDeviationSampler}
			qd.log = log.New()
			resp := qd.parseResponse(ctx, q, res)

			require.Error(t, resp.Error)
			assert.Contains(t, resp.Error.Error(), "unexpected response")
			assert.Len(t, resp.Frames, 1)
			assert.NoError(t, res.Body.Close())
		})
	}
}
