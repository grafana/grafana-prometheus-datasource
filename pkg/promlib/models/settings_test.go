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
