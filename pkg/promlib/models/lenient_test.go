package models_test

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

// Mistyping any property #220 declared was harmless before it, so it must not fail the
// datasource now.
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
				require.Equal(t, 1000.0, float64(*opts.SeriesLimit))
			},
		},
		{
			// 1000.0 is schema-valid but encoding/json rejects it for an integer field.
			name:     "seriesLimit stored as a fractional literal",
			jsonData: `{"seriesLimit":1000.0}`,
			assert: func(t *testing.T, opts *models.PromOptions) {
				require.NotNil(t, opts.SeriesLimit)
				require.Equal(t, 1000.0, float64(*opts.SeriesLimit))
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
				require.Equal(t, 5.0, float64(*opts.SeriesLimit))
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

// Already strict before #220, so they stay strict.
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

// Every lenient property must tolerate any stored type. The key list comes from the struct on
// purpose: the original gap was a property nobody remembered to account for.
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

// strictJSONDataFields fail the datasource on a type mismatch, by design. Only add a property
// here if it predates #220 or is validated separately; otherwise give it a lenient type.
var strictJSONDataFields = map[string]bool{
	"httpMethod":   true,
	"timeInterval": true,
	"queryTimeout": true,
}

// jsonDataKeys returns every json key PromOptions declares. Marshalling a zero value lets
// encoding/json resolve promoted keys; no field uses omitempty, so all of them are present.
func jsonDataKeys(t *testing.T) []string {
	t.Helper()

	data, err := json.Marshal(models.PromOptions{})
	require.NoError(t, err)

	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(data, &fields))
	require.NotEmpty(t, fields)

	return slices.Sorted(maps.Keys(fields))
}

// These warnings are what a strictness migration is decided on, so a correctly typed value must
// stay silent or the signal never goes quiet.
func TestLenientTypes_LogOnlyWhenLenient(t *testing.T) {
	cases := []struct {
		name     string
		jsonData string
		want     []string
	}{
		{
			name:     "correctly typed values log nothing",
			jsonData: `{"seriesEndpoint":true,"seriesLimit":10,"prometheusVersion":"2.50.1"}`,
		},
		{
			name:     "null is absence, not a type mismatch",
			jsonData: `{"seriesEndpoint":null,"seriesLimit":null,"prometheusVersion":null}`,
		},
		{
			name:     "undeclared properties log nothing",
			jsonData: `{"sigV4Auth":123,"someLegacyField":{"a":1}}`,
		},
		{
			name:     "a salvaged boolean is coerced",
			jsonData: `{"seriesEndpoint":"True"}`,
			want:     []string{`string->bool coerced "True"`},
		},
		{
			name:     "an unreadable boolean is dropped",
			jsonData: `{"seriesEndpoint":"banana"}`,
			want:     []string{`string->bool dropped "banana"`},
		},
		{
			name:     "every lenient value is reported, not just the first",
			jsonData: `{"seriesEndpoint":"true","seriesLimit":"10","prometheusVersion":2.4}`,
			want:     []string{`string->bool coerced "true"`, `string->float64 coerced "10"`, `float64->string coerced 2.4`},
		},
		{
			// Every number shape decodes into a float64 target, so none of these needs leniency.
			// An integer field would have rejected 1000.0 and 1e3.
			name:     "any number shape is accepted without coercion",
			jsonData: `{"seriesLimit":1000}`,
		},
		{
			name:     "a fractional literal needs no coercion either",
			jsonData: `{"seriesLimit":1000.0}`,
		},
		{
			name:     "nor does exponent notation",
			jsonData: `{"seriesLimit":1e3}`,
		},
		{
			// Same target and outcome as the string case above; only "from" tells them apart.
			name:     "a number read as a boolean is distinguishable from a string",
			jsonData: `{"seriesEndpoint":1}`,
			want:     []string{`float64->bool coerced 1`},
		},
		{
			// Separate labels rather than one combined value, so each aggregates on its own.
			name:     "a boolean read as a string names bool as the source",
			jsonData: `{"prometheusVersion":true}`,
			want:     []string{`bool->string coerced true`},
		},
		{
			// An unreadable string is a different problem from a structurally wrong value, so the
			// string source is reported either way.
			name:     "an unparseable number string is reported as a string, not unknown",
			jsonData: `{"seriesLimit":"ten","maxSamplesProcessedWarningThreshold":"lots"}`,
			want:     []string{`string->float64 dropped "ten"`, `string->float64 dropped "lots"`},
		},
		{
			name:     "an unusable shape is dropped",
			jsonData: `{"seriesEndpoint":["true"],"oauthPassThru":{"a":1}}`,
			want:     []string{`unknown->bool dropped ["true"]`, `unknown->bool dropped {"a":1}`},
		},
		{
			name:     "a non-list exemplar value is dropped",
			jsonData: `{"exemplarTraceIdDestinations":{"name":"x"}}`,
			want:     []string{`unknown->exemplarDestinations dropped {"name":"x"}`},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logged := captureLenientLogs(t, tc.jsonData)
			if tc.want == nil {
				require.Empty(t, logged)
				return
			}
			require.ElementsMatch(t, tc.want, logged)
		})
	}
}

// captureLenientLogs returns "from->to outcome value" for each warning emitted. It swaps a
// package-level logger, so these cases cannot run in parallel.
func captureLenientLogs(t *testing.T, jsonData string) []string {
	t.Helper()

	restore := log.DefaultLogger
	// Embed the real logger so anything other than Warn passes through instead of panicking
	// on a nil interface.
	recorder := &lenientLogRecorder{Logger: restore}
	log.DefaultLogger = recorder
	defer func() { log.DefaultLogger = restore }()

	_, err := models.ParsePromOptions(backend.DataSourceInstanceSettings{JSONData: []byte(jsonData)})
	require.NoError(t, err)

	return recorder.lenient
}

// Captures every warning, which is all of them: the lenient types are the only thing that logs.
type lenientLogRecorder struct {
	log.Logger
	lenient []string
}

func (r *lenientLogRecorder) Warn(_ string, args ...any) {
	fields := map[string]any{}
	for i := 0; i+1 < len(args); i += 2 {
		if key, ok := args[i].(string); ok {
			fields[key] = args[i+1]
		}
	}
	r.lenient = append(r.lenient,
		fmt.Sprintf("%v->%v %v %v", fields["from"], fields["to"], fields["outcome"], fields["value"]))
}

// seriesLimit is a pointer because unset means "apply your own default" where 0 means "limit is
// zero", so an ignored value must leave it unset rather than assert a limit nobody chose.
func TestParsePromOptions_DroppedPointerIsLeftUnset(t *testing.T) {
	cases := []struct {
		name     string
		jsonData string
		want     *float64
	}{
		{name: "absent stays unset", jsonData: `{}`},
		{name: "null stays unset", jsonData: `{"seriesLimit":null}`},
		{name: "ignored string is left unset", jsonData: `{"seriesLimit":"ten"}`},
		{name: "ignored object is left unset", jsonData: `{"seriesLimit":{}}`},
		{name: "ignored array is left unset", jsonData: `{"seriesLimit":[]}`},
		{name: "ignored boolean is left unset", jsonData: `{"seriesLimit":true}`},

		{name: "a stored number is kept", jsonData: `{"seriesLimit":1000}`, want: ptr(1000)},
		{name: "an explicit zero is kept, not mistaken for unset", jsonData: `{"seriesLimit":0}`, want: ptr(0)},
		{name: "a quoted number is coerced and kept", jsonData: `{"seriesLimit":"1000"}`, want: ptr(1000)},
		{name: "a quoted zero is coerced and kept", jsonData: `{"seriesLimit":"0"}`, want: ptr(0)},
		{name: "a fractional number is kept", jsonData: `{"seriesLimit":1000.5}`, want: ptr(1000.5)},
		{name: "exponent notation is kept", jsonData: `{"seriesLimit":1e3}`, want: ptr(1000)},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts, err := models.ParsePromOptions(backend.DataSourceInstanceSettings{
				JSONData: []byte(tc.jsonData),
			})
			require.NoError(t, err)

			if tc.want == nil {
				require.Nil(t, opts.SeriesLimit)
				return
			}
			require.NotNil(t, opts.SeriesLimit)
			require.Equal(t, *tc.want, float64(*opts.SeriesLimit))
		})
	}
}

func ptr(v float64) *float64 { return &v }

// clearDroppedPointers names seriesLimit explicitly, so a pointer property added later would
// silently keep its allocated zero. This fails when that happens.
func TestPointerPropertiesAreAccountedFor(t *testing.T) {
	corrected := map[string]bool{"seriesLimit": true}

	var walk func(reflect.Type)
	walk = func(structType reflect.Type) {
		for i := range structType.NumField() {
			field := structType.Field(i)
			name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
			if field.Anonymous && name == "" && field.Type.Kind() == reflect.Struct {
				walk(field.Type)
				continue
			}
			if name == "" || name == "-" || field.Type.Kind() != reflect.Pointer {
				continue
			}
			require.True(t, corrected[name],
				"%q is a pointer property: a dropped value would leave it non-nil at zero. "+
					"Handle it in clearDroppedPointers and add it here.", name)
		}
	}
	walk(reflect.TypeOf(models.PromOptions{}))
}
