package schema_test

import (
	_ "embed"
	"net/http"
	"testing"

	"github.com/grafana/dsconfig/schema"
	"github.com/grafana/grafana-plugin-sdk-go/experimental/pluginschema"
	"k8s.io/kube-openapi/pkg/spec3"

	"github.com/grafana/grafana-prometheus-datasource/pkg/promlib/models"
)

//go:embed dsconfig.json
var configSchemaJSON []byte

//go:generate go test -run TestPlugin -generateArtifacts
func TestPlugin(t *testing.T) {
	schema.RunPluginTests(t, schema.PluginUnderTest{
		ID:                "prometheus",
		ConfigSchemaJSON:  configSchemaJSON,
		SettingsJSONModel: models.PromOptions{},
		SecureKeys:        []string{"basicAuthPassword", "tlsCACert", "tlsClientCert", "tlsClientKey"},
		SettingsExamples: &pluginschema.SettingsExamples{
			Examples: map[string]*spec3.Example{
				"": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "Default configuration",
						Description: "The defaults a new datasource starts with: no authentication, POST as the HTTP method. Only root.url needs to be filled in to get a working datasource pointed at a Prometheus server on localhost:9090.",
						Value: map[string]any{
							"url": "http://localhost:9090",
							"jsonData": map[string]any{
								"httpMethod": http.MethodPost,
							},
							"secureJsonData": map[string]any{
								"basicAuthPassword": "",
							},
						},
					},
				},
				"noAuth": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "No authentication",
						Description: "A public or network-isolated Prometheus with no HTTP-level auth. Prometheus type and version are set explicitly so the query editor exposes flavour-specific query hints.",
						Value: map[string]any{
							"url": "http://prometheus.example.com:9090",
							"jsonData": map[string]any{
								"httpMethod":        http.MethodPost,
								"prometheusType":    models.PromApplicationPrometheus,
								"prometheusVersion": "2.50.1",
								"timeInterval":      "15s",
							},
						},
					},
				},
				"basicAuth": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "Basic authentication",
						Description: "Authenticate with a Prometheus that requires HTTP Basic. Both basicAuth and basicAuthUser live at the datasource root; only basicAuthPassword is secret.",
						Value: map[string]any{
							"url":           "https://prometheus.example.com",
							"basicAuth":     true,
							"basicAuthUser": "grafana",
							"jsonData": map[string]any{
								"httpMethod": http.MethodPost,
							},
							"secureJsonData": map[string]any{
								"basicAuthPassword": "REPLACE_WITH_PASSWORD",
							},
						},
					},
				},
				"oauthForward": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "Forward OAuth Identity",
						Description: "Forward the signed-in user's upstream OAuth identity to Prometheus. The editor writes only jsonData.oauthPassThru; there is no accompanying secret.",
						Value: map[string]any{
							"url": "https://prometheus.example.com",
							"jsonData": map[string]any{
								"httpMethod":    http.MethodPost,
								"oauthPassThru": true,
							},
						},
					},
				},
				"tlsMutualAuth": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "TLS mutual auth (mTLS)",
						Description: "Prometheus requiring mTLS. jsonData.tlsAuth=true triggers the SDK to build a client-authenticated transport using serverName plus the PEM-encoded client cert and key in secureJsonData.",
						Value: map[string]any{
							"url": "https://prometheus.example.com",
							"jsonData": map[string]any{
								"httpMethod": http.MethodPost,
								"tlsAuth":    true,
								"serverName": "prometheus.example.com",
							},
							"secureJsonData": map[string]any{
								"tlsClientCert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
								"tlsClientKey":  "-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----",
							},
						},
					},
				},
				"tlsSelfSignedCA": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "Self-signed CA verification",
						Description: "Prometheus behind a private CA. jsonData.tlsAuthWithCACert=true tells the SDK to verify the server certificate against the PEM-encoded CA in secureJsonData.tlsCACert.",
						Value: map[string]any{
							"url": "https://prometheus.internal.corp",
							"jsonData": map[string]any{
								"httpMethod":        http.MethodPost,
								"tlsAuthWithCACert": true,
							},
							"secureJsonData": map[string]any{
								"tlsCACert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
							},
						},
					},
				},
				"getHTTPMethod": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "GET HTTP method (legacy or restricted networks)",
						Description: "Older Prometheus (< 2.1) or environments that block POST. Everything else stays default. seriesEndpoint is enabled to prefer /api/v1/series (which supports POST) over /api/v1/label/*/values.",
						Value: map[string]any{
							"url": "http://legacy-prom.example.com:9090",
							"jsonData": map[string]any{
								"httpMethod":     http.MethodGet,
								"seriesEndpoint": true,
							},
							"secureJsonData": map[string]any{
								"basicAuthPassword": "",
							},
						},
					},
				},
				"mimirWithExemplars": {
					ExampleProps: spec3.ExampleProps{
						Summary:     "Mimir with exemplar drilldown",
						Description: "Grafana Mimir with exemplar trace-ID destinations wired to a Tempo data source. name is the label carrying the trace ID; datasourceUid takes precedence over url when set.",
						Value: map[string]any{
							"url":           "https://mimir.example.com/prometheus",
							"basicAuth":     true,
							"basicAuthUser": "grafana",
							"jsonData": map[string]any{
								"httpMethod":          http.MethodPost,
								"prometheusType":      models.PromApplicationMimir,
								"prometheusVersion":   "2.9.1",
								"timeInterval":        "15s",
								"cacheLevel":          models.PrometheusCacheLevelMedium,
								"incrementalQuerying": true,
								"exemplarTraceIdDestinations": []any{
									map[string]any{
										"name":          "traceID",
										"datasourceUid": "tempo",
									},
								},
							},
							"secureJsonData": map[string]any{
								"basicAuthPassword": "REPLACE_WITH_PASSWORD",
							},
						},
					},
				},
			},
		},
	})
}
