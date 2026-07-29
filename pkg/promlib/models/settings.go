package models

import (
	"encoding/json"
	"fmt"
	"net/http"
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
		return nil, fmt.Errorf("error unmarshalling JSONData: %w", err)
	}
	opts.ApplyDefaults()
	if err := opts.Validate(); err != nil {
		return nil, err
	}
	return &opts, nil
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
