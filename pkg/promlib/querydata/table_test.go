package querydata_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"github.com/grafana/grafana-plugin-sdk-go/data"
	"github.com/stretchr/testify/require"
)

const twoSeriesVector = `{"status":"success","data":{"resultType":"vector","result":[
	{"metric":{"__name__":"up","job":"a"},"value":[1700000000,"1"]},
	{"metric":{"__name__":"up","job":"b"},"value":[1700000000,"0"]}
]}}`

func TestSingleFrameTable(t *testing.T) {
	tests := []struct {
		name    string
		model   map[string]any
		headers map[string]string
		frames  int
	}{
		{name: "instant table query with opt-in", model: map[string]any{"format": "table", "instant": true, "singleFrameTable": true}, frames: 1},
		{name: "no opt-in", model: map[string]any{"format": "table", "instant": true}, frames: 2},
		{name: "time series format", model: map[string]any{"format": "time_series", "instant": true, "singleFrameTable": true}, frames: 2},
		{name: "instant and range", model: map[string]any{"format": "table", "instant": true, "range": true, "singleFrameTable": true}, frames: 3},
		{name: "alerting", model: map[string]any{"format": "table", "instant": true, "singleFrameTable": true}, headers: map[string]string{"FromAlert": "true"}, frames: 2},
		{name: "expressions", model: map[string]any{"format": "table", "instant": true, "singleFrameTable": true}, headers: map[string]string{"http_X-Grafana-From-Expr": "true"}, frames: 2},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tCtx, err := setup()
			require.NoError(t, err)
			tCtx.httpProvider.setResponse(
				&http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"a"},"values":[[1700000000,"1"]]}]}}`))},
				&http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(twoSeriesVector))},
				nil,
			)
			tt.model["expr"] = "up"
			tt.model["refId"] = "A"
			b, err := json.Marshal(tt.model)
			require.NoError(t, err)
			now := time.Unix(1700000000, 0)
			res, err := tCtx.queryData.Execute(context.Background(), &backend.QueryDataRequest{
				PluginContext: backend.PluginContext{GrafanaConfig: config.NewGrafanaCfg(nil)},
				Headers:       tt.headers,
				Queries: []backend.DataQuery{{
					RefID:     "A",
					JSON:      b,
					Interval:  15 * time.Second,
					TimeRange: backend.TimeRange{From: now.Add(-time.Hour), To: now},
				}},
			})
			require.NoError(t, err)
			r := res.Responses["A"]
			require.NoError(t, r.Error)
			require.Len(t, r.Frames, tt.frames)

			if tt.frames == 1 {
				f := r.Frames[0]
				require.Equal(t, data.FrameTypeNumericLong, f.Meta.Type)
				require.Equal(t, "Expr: up\nStep: 15s", f.Meta.ExecutedQueryString)
				require.Equal(t, int64(15000), f.Meta.Custom.(map[string]any)["calculatedMinStep"])
				require.Equal(t, 15000.0, f.Fields[0].Config.Interval)
				require.Equal(t, []string{"Time", "__name__", "job", "Value"}, []string{f.Fields[0].Name, f.Fields[1].Name, f.Fields[2].Name, f.Fields[3].Name})
				require.Equal(t, "b", f.Fields[2].At(1))
				require.Equal(t, 0.0, f.Fields[3].At(1))
			}
		})
	}
}
