package models_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/stretchr/testify/require"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

func settingsWithJSON(t *testing.T, v any) backend.DataSourceInstanceSettings {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return backend.DataSourceInstanceSettings{JSONData: b}
}

func TestParsePromOptions_HTTPMethod(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		wantMethod string
		wantErrStr string
	}{
		{
			name:       "empty defaults to POST",
			input:      "",
			wantMethod: http.MethodPost,
		},
		{
			name:       "lowercase get normalised to GET",
			input:      "get",
			wantMethod: http.MethodGet,
		},
		{
			name:       "mixed-case post normalised to POST",
			input:      "Post",
			wantMethod: http.MethodPost,
		},
		{
			name:       "uppercase POST accepted",
			input:      http.MethodPost,
			wantMethod: http.MethodPost,
		},
		{
			name:       "uppercase GET accepted",
			input:      http.MethodGet,
			wantMethod: http.MethodGet,
		},
		{
			name:       "whitespace-padded get normalised",
			input:      "  get  ",
			wantMethod: http.MethodGet,
		},
		{
			name:       "PUT rejected",
			input:      "PUT",
			wantErrStr: `invalid httpMethod "PUT"`,
		},
		{
			name:       "DELETE rejected",
			input:      "DELETE",
			wantErrStr: `invalid httpMethod "DELETE"`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts, err := models.ParsePromOptions(settingsWithJSON(t, map[string]any{
				"httpMethod": tc.input,
			}))

			if tc.wantErrStr != "" {
				require.ErrorContains(t, err, tc.wantErrStr)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.wantMethod, opts.HTTPMethod)
		})
	}
}

func TestParsePromOptions_MalformedJSON(t *testing.T) {
	settings := backend.DataSourceInstanceSettings{JSONData: []byte(`{not valid json`)}
	_, err := models.ParsePromOptions(settings)
	require.ErrorContains(t, err, "error unmarshalling JSONData")
}

func TestParsePromOptions_EmptyJSONData(t *testing.T) {
	cases := []struct {
		name     string
		jsonData []byte
	}{
		{name: "nil JSONData", jsonData: nil},
		{name: "empty slice", jsonData: []byte{}},
		{name: "empty JSON object", jsonData: []byte(`{}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			settings := backend.DataSourceInstanceSettings{JSONData: tc.jsonData}
			opts, err := models.ParsePromOptions(settings)
			require.NoError(t, err)
			require.Equal(t, http.MethodPost, opts.HTTPMethod)
		})
	}
}

func TestPromOptions_ApplyDefaults(t *testing.T) {
	cases := []struct {
		name       string
		input      models.PromOptions
		wantMethod string
	}{
		{
			name:       "empty HTTPMethod defaults to POST",
			input:      models.PromOptions{},
			wantMethod: http.MethodPost,
		},
		{
			name:       "whitespace-only HTTPMethod defaults to POST",
			input:      models.PromOptions{HTTPMethod: "   "},
			wantMethod: http.MethodPost,
		},
		{
			name:       "lowercase get is normalised to GET",
			input:      models.PromOptions{HTTPMethod: "get"},
			wantMethod: http.MethodGet,
		},
		{
			name:       "mixed-case Post is normalised to POST",
			input:      models.PromOptions{HTTPMethod: "Post"},
			wantMethod: http.MethodPost,
		},
		{
			name:       "whitespace-padded value is trimmed and uppercased",
			input:      models.PromOptions{HTTPMethod: "  get  "},
			wantMethod: http.MethodGet,
		},
		{
			name:       "already-uppercase value is preserved",
			input:      models.PromOptions{HTTPMethod: http.MethodGet},
			wantMethod: http.MethodGet,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := tc.input
			opts.ApplyDefaults()
			require.Equal(t, tc.wantMethod, opts.HTTPMethod)
		})
	}
}

func TestPromOptions_ApplyDefaults_DoesNotMutateUnrelatedFields(t *testing.T) {
	seriesLimit := int64(42)
	opts := models.PromOptions{
		TimeInterval:   "30s",
		QueryTimeout:   "60s",
		PrometheusType: models.PromApplicationPrometheus,
		SeriesLimit:    &seriesLimit,
	}
	opts.ApplyDefaults()

	require.Equal(t, "30s", opts.TimeInterval)
	require.Equal(t, "60s", opts.QueryTimeout)
	require.Equal(t, models.PromApplicationPrometheus, opts.PrometheusType)
	require.NotNil(t, opts.SeriesLimit)
	require.Equal(t, int64(42), *opts.SeriesLimit)
}

func TestPromOptions_Validate(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		wantErrStr string
	}{
		{name: "empty is valid", method: ""},
		{name: "GET is valid", method: http.MethodGet},
		{name: "POST is valid", method: http.MethodPost},
		{name: "lowercase get is valid (Validate uppercases before comparing)", method: "get"},
		{name: "lowercase post is valid", method: "post"},
		{name: "PUT is rejected", method: http.MethodPut, wantErrStr: `invalid httpMethod "PUT"`},
		{name: "DELETE is rejected", method: http.MethodDelete, wantErrStr: `invalid httpMethod "DELETE"`},
		{name: "PATCH is rejected", method: http.MethodPatch, wantErrStr: `invalid httpMethod "PATCH"`},
		{name: "arbitrary string is rejected", method: "foo", wantErrStr: `invalid httpMethod "foo"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts := models.PromOptions{HTTPMethod: tc.method}
			err := opts.Validate()
			if tc.wantErrStr != "" {
				require.ErrorContains(t, err, tc.wantErrStr)
				return
			}
			require.NoError(t, err)
		})
	}
}
