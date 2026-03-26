package promlib

import (
	"sort"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/data"
)

// flattenTimeSeriesToTabular converts Prometheus multi-frame time series response
// (one frame per label combination) into a single flat tabular frame with
// timestamp, value, and label columns for dsabstraction compatibility.
func flattenTimeSeriesToTabular(frames data.Frames) data.Frames {
	if len(frames) == 0 {
		return frames
	}

	type row struct {
		t      time.Time
		value  *float64
		labels data.Labels
	}

	var rows []row
	labelKeysSet := map[string]struct{}{}

	for _, frame := range frames {
		var timeField *data.Field
		for _, f := range frame.Fields {
			if f.Type() == data.FieldTypeTime || f.Type() == data.FieldTypeNullableTime {
				timeField = f
				break
			}
		}
		if timeField == nil {
			continue
		}

		for _, f := range frame.Fields {
			if !f.Type().Numeric() {
				continue
			}
			for k := range f.Labels {
				if k != "__name__" {
					labelKeysSet[k] = struct{}{}
				}
			}
			for i := 0; i < f.Len(); i++ {
				t := timeField.At(i).(time.Time)
				v, err := f.FloatAt(i)
				if err != nil {
					continue
				}
				val := v
				rows = append(rows, row{
					t:      t,
					value:  &val,
					labels: f.Labels,
				})
			}
		}
	}

	if len(rows) == 0 {
		return frames
	}

	labelKeys := make([]string, 0, len(labelKeysSet))
	for k := range labelKeysSet {
		labelKeys = append(labelKeys, k)
	}
	sort.Strings(labelKeys)

	sort.SliceStable(rows, func(i, j int) bool {
		return rows[i].t.Before(rows[j].t)
	})

	timestamps := make([]time.Time, len(rows))
	values := make([]*float64, len(rows))
	labelCols := make(map[string][]*string, len(labelKeys))
	for _, k := range labelKeys {
		labelCols[k] = make([]*string, len(rows))
	}

	for i, r := range rows {
		timestamps[i] = r.t
		values[i] = r.value
		for _, k := range labelKeys {
			if v, ok := r.labels[k]; ok {
				labelCols[k][i] = &v
			}
		}
	}

	fields := make([]*data.Field, 0, 2+len(labelKeys))
	fields = append(fields,
		data.NewField("timestamp", nil, timestamps),
		data.NewField("value", nil, values),
	)
	for _, k := range labelKeys {
		fields = append(fields, data.NewField(k, nil, labelCols[k]))
	}

	out := data.NewFrame("", fields...)
	return data.Frames{out}
}
