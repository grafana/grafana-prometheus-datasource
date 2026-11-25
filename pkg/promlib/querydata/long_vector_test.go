package querydata_test

import (
	"testing"
	"time"

	p "github.com/prometheus/common/model"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/data"
)

func TestLongVector(t *testing.T) {
	vector := queryResult{
		Type: p.ValVector,
		Result: p.Vector{
			&p.Sample{Metric: p.Metric{"__name__": "up", "job": "b"}, Value: 1, Timestamp: 1700000000000},
			&p.Sample{Metric: p.Metric{"__name__": "up", "job": "a", "instance": "x"}, Value: 2, Timestamp: 1700000000000},
		},
	}
	matrix := queryResult{
		Type: p.ValMatrix,
		Result: p.Matrix{
			&p.SampleStream{Metric: p.Metric{"job": "a"}, Values: []p.SamplePair{{Timestamp: 1700000000000, Value: 1}}},
			&p.SampleStream{Metric: p.Metric{"job": "b"}, Values: []p.SamplePair{{Timestamp: 1700000000000, Value: 2}}},
		},
	}
	query := func(json string) backend.DataQuery {
		return backend.DataQuery{
			RefID:     "A",
			Interval:  15 * time.Second,
			TimeRange: backend.TimeRange{From: time.Unix(1700000000, 0), To: time.Unix(1700000300, 0)},
			JSON:      []byte(json),
		}
	}
	fieldNames := func(frame *data.Frame) []string {
		names := make([]string, 0, len(frame.Fields))
		for _, f := range frame.Fields {
			names = append(names, f.Name)
		}
		return names
	}

	t.Run("instant query with the opt-in returns one long frame", func(t *testing.T) {
		tctx, err := setup()
		require.NoError(t, err)
		frames, err := execute(tctx, query(`{"refId":"A","expr":"up","instant":true,"range":false,"format":"table","longVector":true}`), nil, vector, nil)
		require.NoError(t, err)
		require.Len(t, frames, 1)

		frame := frames[0]
		require.Equal(t, data.FrameTypeNumericLong, frame.Meta.Type)
		require.Equal(t, []string{"Time", "__name__", "job", "instance", "Value"}, fieldNames(frame))
		require.Equal(t, 2, frame.Rows())
		require.Equal(t, "Expr: up\nStep: 15s", frame.Meta.ExecutedQueryString)
		require.Equal(t, int64(15000), frame.Meta.Custom.(map[string]any)["calculatedMinStep"])
		require.Equal(t, float64(15000), frame.Fields[0].Config.Interval)
		for _, f := range frame.Fields[1:4] {
			require.NotNil(t, f.Config.Filterable)
			require.True(t, *f.Config.Filterable)
		}
		require.Nil(t, frame.Fields[4].Config, "no per-series DisplayNameFromDS on a long frame")
	})

	t.Run("instant query without the opt-in keeps one frame per series", func(t *testing.T) {
		tctx, err := setup()
		require.NoError(t, err)
		frames, err := execute(tctx, query(`{"refId":"A","expr":"up","instant":true,"range":false,"format":"table"}`), nil, vector, nil)
		require.NoError(t, err)
		require.Len(t, frames, 2)
		require.Equal(t, data.FrameTypeNumericMulti, frames[0].Meta.Type)
	})

	t.Run("range query ignores the opt-in", func(t *testing.T) {
		tctx, err := setup()
		require.NoError(t, err)
		frames, err := execute(tctx, query(`{"refId":"A","expr":"up","instant":false,"range":true,"longVector":true}`), matrix, nil, nil)
		require.NoError(t, err)
		require.Len(t, frames, 2)
		require.Equal(t, data.FrameTypeTimeSeriesMulti, frames[0].Meta.Type)
	})

	t.Run("alerting request ignores the opt-in", func(t *testing.T) {
		tctx, err := setup()
		require.NoError(t, err)
		frames, err := executeWithHeaders(tctx, query(`{"refId":"A","expr":"up","instant":true,"range":false,"format":"table","longVector":true}`), nil, vector, nil, map[string]string{"FromAlert": "true"})
		require.NoError(t, err)
		require.Len(t, frames, 2)
		require.Equal(t, data.FrameTypeNumericMulti, frames[0].Meta.Type)
	})
}
