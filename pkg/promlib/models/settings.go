// Package models holds the Prometheus datasource configuration model.
//
// PrometheusSettings is the single source of truth for the plugin-owned
// jsonData surface. Its json tags mirror the frontend PromOptions interface
// (packages/grafana-prometheus/src/types.ts) that the ConfigEditor binds to.
// The promlib backend reads these jsonData values dynamically (via maputil), so
// this struct exists to keep the dsconfig schema and the settings surface in
// lockstep: the schema conformance test asserts these json tags exactly match
// the schema's jsonData field keys.
package models

// PrometheusSettings models the plugin-owned jsonData fields of the Prometheus
// datasource. Platform-managed and HTTP/TLS auth fields (basic auth, TLS,
// sigV4, azure credentials, custom headers, PDC, etc.) are handled by Grafana's
// shared datasource settings and are intentionally not modelled here.
type PrometheusSettings struct {
	TimeInterval                  string                       `json:"timeInterval,omitempty"`
	QueryTimeout                  string                       `json:"queryTimeout,omitempty"`
	HTTPMethod                    string                       `json:"httpMethod,omitempty"`
	CustomQueryParameters         string                       `json:"customQueryParameters,omitempty"`
	DisableMetricsLookup          bool                         `json:"disableMetricsLookup,omitempty"`
	ExemplarTraceIDDestinations   []ExemplarTraceIDDestination `json:"exemplarTraceIdDestinations,omitempty"`
	PrometheusType                string                       `json:"prometheusType,omitempty"`
	PrometheusVersion             string                       `json:"prometheusVersion,omitempty"`
	CacheLevel                    string                       `json:"cacheLevel,omitempty"`
	DefaultEditor                 string                       `json:"defaultEditor,omitempty"`
	IncrementalQuerying           bool                         `json:"incrementalQuerying,omitempty"`
	IncrementalQueryOverlapWindow string                       `json:"incrementalQueryOverlapWindow,omitempty"`
	DisableRecordingRules         bool                         `json:"disableRecordingRules,omitempty"`
	AllowAsRecordingRulesTarget   bool                         `json:"allowAsRecordingRulesTarget,omitempty"`
	OauthPassThru                 bool                         `json:"oauthPassThru,omitempty"`
	SeriesEndpoint                bool                         `json:"seriesEndpoint,omitempty"`
	SeriesLimit                   int                          `json:"seriesLimit,omitempty"`
}

// ExemplarTraceIDDestination configures a link from a Prometheus exemplar trace
// ID to a tracing backend. Mirrors the ExemplarTraceIdDestination type in the
// frontend PromOptions surface.
type ExemplarTraceIDDestination struct {
	Name            string `json:"name"`
	URL             string `json:"url,omitempty"`
	URLDisplayLabel string `json:"urlDisplayLabel,omitempty"`
	DatasourceUID   string `json:"datasourceUid,omitempty"`
}
