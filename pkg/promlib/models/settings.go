package models

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// DataSourceJsonData mirrors the base @grafana/data DataSourceJsonData interface
// that all Grafana datasource jsonData types extend.
type DataSourceJsonData struct {
	AuthType                    string `json:"authType"`
	DefaultRegion               string `json:"defaultRegion"`
	Profile                     string `json:"profile"`
	ManageAlerts                bool   `json:"manageAlerts"`
	AllowAsRecordingRulesTarget bool   `json:"allowAsRecordingRulesTarget"`
	AlertmanagerUID             string `json:"alertmanagerUid"`
	DisableGrafanaCache         bool   `json:"disableGrafanaCache"`
}

// PromOptions holds the typed datasource configuration stored in jsonData.
// It mirrors the frontend PromOptions interface (packages/grafana-prometheus/src/types.ts)
// which extends DataSourceJsonData.
type PromOptions struct {
	// PromOptions extends DataSourceJsonData.
	// Even though it is not directly consumed by the prom datasource, it is consumed via plugin-sdk.
	DataSourceJsonData
	HTTPMethod                          string  `json:"httpMethod"`
	TimeInterval                        string  `json:"timeInterval"`
	QueryTimeout                        string  `json:"queryTimeout"`
	CustomQueryParameters               string  `json:"customQueryParameters"`
	MaxSamplesProcessedWarningThreshold float64 `json:"maxSamplesProcessedWarningThreshold"`
	MaxSamplesProcessedErrorThreshold   float64 `json:"maxSamplesProcessedErrorThreshold"`
	QueryStatsEnabled                   bool    `json:"queryStatsEnabled"`

	// Frontend only types
	PrometheusType                string                       `json:"prometheusType"`
	PrometheusVersion             string                       `json:"prometheusVersion"`
	DisableMetricsLookup          bool                         `json:"disableMetricsLookup"`
	CacheLevel                    string                       `json:"cacheLevel"`
	DefaultEditor                 string                       `json:"defaultEditor"`
	IncrementalQuerying           bool                         `json:"incrementalQuerying"`
	IncrementalQueryOverlapWindow string                       `json:"incrementalQueryOverlapWindow"`
	DisableRecordingRules         bool                         `json:"disableRecordingRules"`
	OauthPassThru                 bool                         `json:"oauthPassThru"`
	SeriesEndpoint                bool                         `json:"seriesEndpoint"`
	SeriesLimit                   *int64                       `json:"seriesLimit"`
	ExemplarTraceIDDestinations   []ExemplarTraceIDDestination `json:"exemplarTraceIdDestinations"`
}

// ExemplarTraceIDDestination mirrors the frontend ExemplarTraceIdDestination type.
type ExemplarTraceIDDestination struct {
	Name            string `json:"name"`
	URL             string `json:"url,omitempty"`
	URLDisplayLabel string `json:"urlDisplayLabel,omitempty"`
	DatasourceUID   string `json:"datasourceUid,omitempty"`
}

// ParsePromOptions deserialises the datasource jsonData blob into a typed PromOptions
// struct and validates the fields that are actively used by the backend.
func ParsePromOptions(settings backend.DataSourceInstanceSettings) (*PromOptions, error) {
	var opts PromOptions
	data := settings.JSONData
	if len(data) == 0 {
		data = []byte("{}")
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		// Strict unmarshal failed — try lenient unmarshal with type coercion.
		// Datasources provisioned through the API or Terraform may store values
		// with off-spec types (e.g., string "true" for a bool field, number 15
		// for a string field).  The UI always writes normalized types, and the
		// previous schemaless reader accepted both.
		raw := make(map[string]any)
		if err2 := json.Unmarshal(data, &raw); err2 != nil {
			return nil, fmt.Errorf("error unmarshalling JSONData: %w", err)
		}
		coercePromOptions(raw)
		coerced, err2 := json.Marshal(raw)
		if err2 != nil {
			return nil, fmt.Errorf("error unmarshalling JSONData: %w", err)
		}
		if err2 := json.Unmarshal(coerced, &opts); err2 != nil {
			return nil, fmt.Errorf("error unmarshalling JSONData: %w", err)
		}
	}
	opts.ApplyDefaults()
	if err := opts.Validate(); err != nil {
		return nil, err
	}
	return &opts, nil
}

// coercePromOptions normalises field types in a raw JSON map so that
// a subsequent strict unmarshal into PromOptions succeeds.  Fields that
// arrive from the API or Terraform with mismatched types are converted
// to the expected Go type in place.
func coercePromOptions(raw map[string]any) {
	// Boolean fields: accept string "true"/"false" and number 0/1.
	for _, key := range []string{
		"manageAlerts", "allowAsRecordingRulesTarget",
		"queryStatsEnabled", "disableMetricsLookup",
		"incrementalQuerying", "disableRecordingRules",
		"oauthPassThru", "seriesEndpoint", "disableGrafanaCache",
	} {
		if v, ok := raw[key]; ok {
			switch val := v.(type) {
			case string:
				raw[key] = val == "true" || val == "1" || val == "yes"
			case float64:
				raw[key] = val != 0
			}
		}
	}

	// String fields: accept numbers.
	for _, key := range []string{
		"timeInterval", "queryTimeout", "customQueryParameters",
		"httpMethod", "prometheusType", "prometheusVersion",
		"cacheLevel", "defaultEditor", "incrementalQueryOverlapWindow",
		"alertmanagerUid", "authType", "defaultRegion", "profile",
	} {
		if v, ok := raw[key]; ok {
			if num, ok := v.(float64); ok {
				raw[key] = strconv.FormatFloat(num, 'f', -1, 64)
			}
		}
	}

	// *int64 fields: accept string numbers and float64.
	if v, ok := raw["seriesLimit"]; ok {
		switch val := v.(type) {
		case string:
			if n, err := strconv.ParseInt(val, 10, 64); err == nil {
				raw["seriesLimit"] = n
			}
		case float64:
			raw["seriesLimit"] = int64(val)
		}
	}

	// float64 fields: accept string numbers.
	for _, key := range []string{
		"maxSamplesProcessedWarningThreshold",
		"maxSamplesProcessedErrorThreshold",
	} {
		if v, ok := raw[key]; ok {
			if s, ok := v.(string); ok {
				if n, err := strconv.ParseFloat(s, 64); err == nil {
					raw[key] = n
				}
			}
		}
	}

	// ExemplarTraceIDDestination: accept a single object (map) in addition to
	// an array.  Some API/Terraform configurations store a single destination
	// as a JSON object rather than a one-element array.
	if v, ok := raw["exemplarTraceIdDestinations"]; ok {
		if _, ok := v.(map[string]any); ok {
			raw["exemplarTraceIdDestinations"] = []any{v}
		}
	}
}

// ApplyDefaults normalises fields and sets missing values to their defaults.
func (o *PromOptions) ApplyDefaults() {
	o.HTTPMethod = strings.ToUpper(strings.TrimSpace(o.HTTPMethod))
	if o.HTTPMethod == "" {
		o.HTTPMethod = http.MethodPost
	}
}

// Validate checks the fields of PromOptions that are consumed by the backend.
// Only fields that are actually read during query/resource/transport setup are validated.
func (o *PromOptions) Validate() error {
	// HTTPMethod: must be empty (defaults to POST), GET, or POST.
	if m := strings.ToUpper(o.HTTPMethod); m != "" && m != http.MethodGet && m != http.MethodPost {
		return fmt.Errorf("invalid httpMethod %q: must be GET or POST", o.HTTPMethod)
	}
	return nil
}