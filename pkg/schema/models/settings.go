// Package models holds the Go representation of the Prometheus data source
// settings. The json tags on PrometheusSettings are the single source of truth
// that the dsconfig conformance suite compares against dsconfig.json.
package models

// ExemplarTraceIDDestination links exemplar trace IDs to a tracing backend.
type ExemplarTraceIDDestination struct {
	Name            string `json:"name"`
	URL             string `json:"url,omitempty"`
	URLDisplayLabel string `json:"urlDisplayLabel,omitempty"`
	DatasourceUID   string `json:"datasourceUid,omitempty"`
}

// HTTPHeader is a custom HTTP header sent with every request.
type HTTPHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// PrometheusSettings models the jsonData fields of the Prometheus data source.
// Every json tag here must match a jsonData field in dsconfig.json.
type PrometheusSettings struct {
	TimeInterval                  string                       `json:"timeInterval"`
	QueryTimeout                  string                       `json:"queryTimeout"`
	HTTPMethod                    string                       `json:"httpMethod"`
	CustomQueryParameters         string                       `json:"customQueryParameters"`
	DisableMetricsLookup          bool                         `json:"disableMetricsLookup"`
	ExemplarTraceIDDestinations   []ExemplarTraceIDDestination `json:"exemplarTraceIdDestinations"`
	PrometheusType                string                       `json:"prometheusType"`
	PrometheusVersion             string                       `json:"prometheusVersion"`
	CacheLevel                    string                       `json:"cacheLevel"`
	DefaultEditor                 string                       `json:"defaultEditor"`
	IncrementalQuerying           bool                         `json:"incrementalQuerying"`
	IncrementalQueryOverlapWindow string                       `json:"incrementalQueryOverlapWindow"`
	DisableRecordingRules         bool                         `json:"disableRecordingRules"`
	ManageAlerts                  bool                         `json:"manageAlerts"`
	AllowAsRecordingRulesTarget   bool                         `json:"allowAsRecordingRulesTarget"`
	OAuthPassThru                bool                         `json:"oauthPassThru"`
	SeriesEndpoint                bool                         `json:"seriesEndpoint"`
	SeriesLimit                   int                          `json:"seriesLimit"`
	MaxSamplesProcessedWarning    int                          `json:"maxSamplesProcessedWarningThreshold"`
	MaxSamplesProcessedError      int                          `json:"maxSamplesProcessedErrorThreshold"`
	Timeout                       int                          `json:"timeout"`
	ServerName                    string                       `json:"serverName"`
	TLSAuth                       bool                         `json:"tlsAuth"`
	TLSAuthWithCACert             bool                         `json:"tlsAuthWithCACert"`
	TLSSkipVerify                 bool                         `json:"tlsSkipVerify"`
	KeepCookies                   []string                     `json:"keepCookies"`
	PdcInjected                   bool                         `json:"pdcInjected"`
	HTTPHeaders                   []HTTPHeader                 `json:"httpHeaders"`
}
