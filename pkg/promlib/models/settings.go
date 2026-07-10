package models

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

// PromOptions holds the typed datasource configuration stored in jsonData.
type PromOptions struct {
	HTTPMethod   string `json:"httpMethod"`
	TimeInterval string `json:"timeInterval"`
	QueryTimeout string `json:"queryTimeout"`
	// Following fields are parsed for schema completeness but not yet consumed directly
	// by the backend. They are currently read via opts.CustomOptions["grafanaData"]
	// managed by the Grafana plugin SDK. TODO: migrate in a follow-up PR.
	PrometheusType                      PromApplication              `json:"prometheusType"`
	PrometheusVersion                   string                       `json:"prometheusVersion"`
	CustomQueryParameters               string                       `json:"customQueryParameters"`
	MaxSamplesProcessedWarningThreshold float64                      `json:"maxSamplesProcessedWarningThreshold"`
	MaxSamplesProcessedErrorThreshold   float64                      `json:"maxSamplesProcessedErrorThreshold"`
	DisableMetricsLookup                bool                         `json:"disableMetricsLookup"`
	CacheLevel                          PrometheusCacheLevel         `json:"cacheLevel"`
	DefaultEditor                       QueryEditorMode              `json:"defaultEditor"`
	IncrementalQuerying                 bool                         `json:"incrementalQuerying"`
	IncrementalQueryOverlapWindow       string                       `json:"incrementalQueryOverlapWindow"`
	DisableRecordingRules               bool                         `json:"disableRecordingRules"`
	OauthPassThru                       bool                         `json:"oauthPassThru"`
	SeriesEndpoint                      bool                         `json:"seriesEndpoint"`
	SeriesLimit                         *int64                       `json:"seriesLimit"`
	ExemplarTraceIDDestinations         []ExemplarTraceIDDestination `json:"exemplarTraceIdDestinations"`
	ManageAlerts                        bool                         `json:"manageAlerts"`
	AllowAsRecordingRulesTarget         bool                         `json:"allowAsRecordingRulesTarget"`
	// Following fields are not direclty used by prom datasource
	// These fields are managed by the Grafana plugin SDK.
	TimeOut           int64    `json:"timeout"`
	KeepCookies       []string `json:"keepCookies"`
	TLSAuth           bool     `json:"tlsAuth"`
	ServerName        string   `json:"serverName"`
	TLSAuthWithCACert bool     `json:"tlsAuthWithCACert"`
	TLSSkipVerify     bool     `json:"tlsSkipVerify"`
}

// ExemplarTraceIDDestination mirrors the frontend ExemplarTraceIdDestination type.
type ExemplarTraceIDDestination struct {
	Name            string `json:"name"`
	URL             string `json:"url,omitempty"`
	URLDisplayLabel string `json:"urlDisplayLabel,omitempty"`
	DatasourceUID   string `json:"datasourceUid,omitempty"`
}

// PromApplication mirrors the frontend PromApplication enum
type PromApplication string

const (
	PromApplicationPrometheus PromApplication = "Prometheus"
	PromApplicationCortex     PromApplication = "Cortex"
	PromApplicationMimir      PromApplication = "Mimir"
	PromApplicationThanos     PromApplication = "Thanos"
)

// PrometheusCacheLevel mirrors the frontend PrometheusCacheLevel enum
type PrometheusCacheLevel string

const (
	PrometheusCacheLevelLow    PrometheusCacheLevel = "Low"
	PrometheusCacheLevelMedium PrometheusCacheLevel = "Medium"
	PrometheusCacheLevelHigh   PrometheusCacheLevel = "High"
	PrometheusCacheLevelNone   PrometheusCacheLevel = "None"
)

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
