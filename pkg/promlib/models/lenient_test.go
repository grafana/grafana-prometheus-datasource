package models_test

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// Provisioning, Terraform and operators all store values whose JSON type does not match
// the struct. Mistyping any property #220 declared was harmless before it, so it must not
// fail the datasource now.
func TestParsePromOptions_LooselyTypedJSONData(t *testing.T) {
	cases := []struct {
		name     string
		jsonData string
		assert   func(t *testing.T, opts *models.PromOptions)
	}{
		{
			name:     "booleans stored as quoted strings",
			jsonData: `{"seriesEndpoint":"true","disableRecordingRules":"false","oauthPassThru":"1"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.True(t, bool(opts.SeriesEndpoint))
				require.False(t, bool(opts.DisableRecordingRules))
				require.True(t, bool(opts.OauthPassThru))
			},
		},
		{
			name:     "capitalised booleans are not silently inverted",
			jsonData: `{"seriesEndpoint":"True","disableMetricsLookup":"TRUE","incrementalQuerying":"False"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.True(t, bool(opts.SeriesEndpoint))
				require.True(t, bool(opts.DisableMetricsLookup))
				require.False(t, bool(opts.IncrementalQuerying))
			},
		},
		{
			name:     "an unrecognised boolean spelling falls back to false",
			jsonData: `{"seriesEndpoint":"yes","oauthPassThru":"maybe"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.False(t, bool(opts.SeriesEndpoint))
				require.False(t, bool(opts.OauthPassThru))
			},
		},
		{
			name:     "booleans stored as 0/1",
			jsonData: `{"queryStatsEnabled":1,"disableMetricsLookup":0}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.True(t, bool(opts.QueryStatsEnabled))
				require.False(t, bool(opts.DisableMetricsLookup))
			},
		},
		{
			// Promoted fields live on the embedded struct, easy to miss.
			name:     "promoted fields on the embedded struct are lenient too",
			jsonData: `{"manageAlerts":"true","allowAsRecordingRulesTarget":1,"alertmanagerUid":42}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.True(t, bool(opts.ManageAlerts))
				require.True(t, bool(opts.AllowAsRecordingRulesTarget))
				require.Equal(t, "42", string(opts.AlertmanagerUID))
			},
		},
		{
			name:     "strings stored as bare numbers keep their text",
			jsonData: `{"incrementalQueryOverlapWindow":10,"prometheusVersion":2.4,"customQueryParameters":123}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.Equal(t, "10", string(opts.IncrementalQueryOverlapWindow))
				require.Equal(t, "2.4", string(opts.PrometheusVersion))
				require.Equal(t, "123", string(opts.CustomQueryParameters))
			},
		},
		{
			name:     "thresholds stored as quoted numbers",
			jsonData: `{"maxSamplesProcessedWarningThreshold":"100000","maxSamplesProcessedErrorThreshold":"200000"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.Equal(t, 100000.0, float64(opts.MaxSamplesProcessedWarningThreshold))
				require.Equal(t, 200000.0, float64(opts.MaxSamplesProcessedErrorThreshold))
			},
		},
		{
			name:     "seriesLimit stored as a quoted number",
			jsonData: `{"seriesLimit":"1000"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.NotNil(t, opts.SeriesLimit)
				require.Equal(t, int64(1000), int64(*opts.SeriesLimit))
			},
		},
		{
			// 1000.0 is schema-valid but encoding/json rejects it for an integer field.
			name:     "seriesLimit stored as a fractional literal",
			jsonData: `{"seriesLimit":1000.0}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.NotNil(t, opts.SeriesLimit)
				require.Equal(t, int64(1000), int64(*opts.SeriesLimit))
			},
		},
		{
			// Not salvaged into a one-element list: the backend never reads this, so a
			// guessed value would only disagree with what the frontend reads.
			name:     "an exemplar value that is not a list is ignored",
			jsonData: `{"exemplarTraceIdDestinations":{"name":"traceID"},"queryStatsEnabled":"true"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.Empty(t, opts.ExemplarTraceIDDestinations)
				require.True(t, bool(opts.QueryStatsEnabled))
			},
		},
		{
			name:     "a well-formed exemplar list still decodes",
			jsonData: `{"exemplarTraceIdDestinations":[{"name":"traceID","datasourceUid":"abc"}]}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.Len(t, opts.ExemplarTraceIDDestinations, 1)
				require.Equal(t, "traceID", opts.ExemplarTraceIDDestinations[0].Name)
				require.Equal(t, "abc", opts.ExemplarTraceIDDestinations[0].DatasourceUID)
			},
		},
		{
			name:     "a value that cannot be read falls back to the zero value",
			jsonData: `{"seriesEndpoint":{"a":1},"prometheusVersion":["x"],"queryStatsEnabled":"true"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.False(t, bool(opts.SeriesEndpoint))
				require.Empty(t, opts.PrometheusVersion)
				require.True(t, bool(opts.QueryStatsEnabled))
			},
		},
		{
			name:     "a mistyped field does not discard the fields around it",
			jsonData: `{"httpMethod":"GET","timeInterval":"30s","seriesLimit":"5","queryStatsEnabled":"true"}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.Equal(t, http.MethodGet, opts.HTTPMethod)
				require.Equal(t, "30s", opts.TimeInterval)
				require.NotNil(t, opts.SeriesLimit)
				require.Equal(t, int64(5), int64(*opts.SeriesLimit))
				require.True(t, bool(opts.QueryStatsEnabled))
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts, err := models.ParsePromOptions(backend.DataSourceInstanceSettings{
				JSONData: []byte(tc.jsonData),
			})
			require.NoError(t, err)
			tc.assert(t, opts)
		})
	}
}

// These two were already strict before #220, so they stay strict — this shim only absorbs
// the discrepancies #220 introduced.
func TestParsePromOptions_PreexistingStrictFieldsStayStrict(t *testing.T) {
	for _, jsonData := range []string{
		`{"httpMethod":30}`,
		`{"timeInterval":30}`,
		`{"queryTimeout":60}`,
	} {
		t.Run(jsonData, func(t *testing.T) {
			_, err := models.ParsePromOptions(backend.DataSourceInstanceSettings{
				JSONData: []byte(jsonData),
			})
			require.ErrorContains(t, err, "error unmarshalling JSONData")
		})
	}
}

// Every lenient property must tolerate any stored type. The key list comes from the struct
// rather than a fixed list on purpose: the original gap was a property nobody remembered to
// account for, and a property added without a lenient type fails here instead of shipping.
func TestParsePromOptions_LenientFieldsCannotFailTheDatasource(t *testing.T) {
	values := []string{
		`"true"`, `"false"`, `"True"`, `"nonsense"`, `true`, `false`, `1`, `0`,
		`30.5`, `30.0`, `60`, `"60"`, `"30s"`, `"abc"`, `""`, `null`,
		`[]`, `["a"]`, `[1]`, `{}`, `{"a":1}`,
	}

	for _, key := range jsonDataKeys(t) {
		if strictJSONDataFields[key] {
			continue
		}
		for _, value := range values {
			jsonData := fmt.Sprintf(`{%q:%s}`, key, value)
			t.Run(key+"="+value, func(t *testing.T) {
				opts, err := models.ParsePromOptions(backend.DataSourceInstanceSettings{
					JSONData: []byte(jsonData),
				})
				require.NoError(t, err, "jsonData %s must not fail the datasource", jsonData)
				require.NotNil(t, opts)
			})
		}
	}
}

// strictJSONDataFields fail the datasource on a type mismatch, by design. A property only
// belongs here if it was strict before #220 or is validated separately — if a new property
// shows up in the test above, give it a lenient type from lenient.go rather than listing it.
var strictJSONDataFields = map[string]bool{
	"httpMethod":   true,
	"timeInterval": true,
	"queryTimeout": true,
}

// jsonDataKeys returns every json key PromOptions declares. Marshalling a zero value lets
// encoding/json resolve the keys promoted from embedded structs, so this stays in step with
// how jsonData is actually decoded. No field uses omitempty, so every key is present.
func jsonDataKeys(t *testing.T) []string {
	t.Helper()

	data, err := json.Marshal(models.PromOptions{})
	require.NoError(t, err)

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &fields))
	require.NotEmpty(t, fields)

	return slices.Sorted(maps.Keys(fields))
}
