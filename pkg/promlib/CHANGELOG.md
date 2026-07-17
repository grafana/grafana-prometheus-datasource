# promlib

## 0.0.14

🐛 added settings model for customQueryParameters, maxSamplesProcessedWarningThreshold, maxSamplesProcessedErrorThreshold ([#225](https://github.com/grafana/grafana-prometheus-datasource/pull/225))

⚙️ Bump grafana-plugin-sdk-go v0.292.2 to have support AlertForwarderMiddleware ([#226](https://github.com/grafana/grafana-prometheus-datasource/pull/226))

🐛 Enable forwarding http headers ([#229](https://github.com/grafana/grafana-prometheus-datasource/pull/229))

🐛 replace schemaless jsonData map with typed PromOptions model ([#220](https://github.com/grafana/grafana-prometheus-datasource/pull/220))

🐛 Fix GetSuggestions silently dropping X-Grafana-Cache so suggestion responses now respect the caller's cache-control directive. ([#234](https://github.com/grafana/grafana-prometheus-datasource/pull/234))

🐛 Fix resource-handler 500s caused by header/body mismatch and tighten upstream header forwarding. ([#232](https://github.com/grafana/grafana-prometheus-datasource/pull/232))

## 0.0.13

🐛 Bug: Fix running backend tests (#199)

🔐 Chore: Bump backend versions (#198)

🚀 feat: add max samples processed warning/error thresholds to Prometheus data source config (#78)

## 0.0.12

🔐 Dependency version bumps for security

🚀 Add support for decoding compressed responses (#93)

🔐 Chore: Bump go version to v1.26.3 (#92)

🚀 Schemads: Surface per-metric metadata via schemads TableMetadata (#79)

🚀 Add support for decoding compressed response bodies
