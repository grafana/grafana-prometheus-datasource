# promlib

## 0.0.21

🐛 added datasource config schema ([#228](https://github.com/grafana/grafana-prometheus-datasource/pull/228))

🐛 Fix security vulnerabilities (CVE-2026-84445) ([#366](https://github.com/grafana/grafana-prometheus-datasource/pull/366))

## 0.0.20

🐛 Support PromQL anchored and smoothed range selectors in the query builder, code editor, scope filtering, and label suggestions. ([#343](https://github.com/grafana/grafana-prometheus-datasource/pull/343))

🐛 Surface Mimir query stats in the Inspector's Stats tab ([#319](https://github.com/grafana/grafana-prometheus-datasource/pull/319))

🐛 Fix: Stop rejecting loosely-typed jsonData (e.g. `"true"` for a boolean, `"1000"` for a number) so datasources provisioned with off-spec values load instead of failing every query and health check. `timeInterval`, `queryTimeout` and `httpMethod` still reject a wrong type. ([#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310))

**Breaking (Go API):** affected `models.PromOptions` fields move from plain `string`/`bool`/`float64`/`*int64` to named lenient types with the same JSON encoding. Passing one to a `string`/`bool`/`float64` parameter now needs an explicit conversion. See [#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310) for details. ([#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310))

🐛 Parse datasource jsonData once per instance construction instead of independently in the transport, query handler, and resource handler. Reduces redundant parsing/logging. ([#341](https://github.com/grafana/grafana-prometheus-datasource/pull/341))

🐛 Request gzip for resource calls to prevent failures caused by forwarding the browser's Accept-Encoding to upstream servers ([#334](https://github.com/grafana/grafana-prometheus-datasource/pull/334))

## 0.0.19

🐛 Improve histogram parsing performance ([#299](https://github.com/grafana/grafana-prometheus-datasource/pull/299))

🐛 Improve numeric value parsing performance ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Add search api backend support ([#304](https://github.com/grafana/grafana-prometheus-datasource/pull/304))

🐛 Bump go v1.26.7 and grafana-plugin-sdk-go v0.296.4 ([#251](https://github.com/grafana/grafana-prometheus-datasource/pull/251))

🐛 Removing abstraction related logic. Abstraction PoC has concluded, cleaning up relevant code. ([#318](https://github.com/grafana/grafana-prometheus-datasource/pull/318))

🐛 Improve numeric value parsing performance ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

## 0.0.18

⚙️ Bump grafana-plugin-sdk-go to v0.294.0, enabling diagnostic bundle HTTP capture ([#288](https://github.com/grafana/grafana-prometheus-datasource/pull/288))

🐛 Fix: force GET method for /api/v1/status/buildinfo to prevent 405 errors on POST-configured datasources ([#293](https://github.com/grafana/grafana-prometheus-datasource/pull/293))

## 0.0.17

🐛 Request and expose Prometheus query statistics ([#259](https://github.com/grafana/grafana-prometheus-datasource/pull/259))

## 0.0.16

🐛 Improve benchmark tests

🐛 Re-add GetJsonData function ([#265](https://github.com/grafana/grafana-prometheus-datasource/pull/265))

## 0.0.15

🐛 Export CalculatePrometheusInterval so external datasources can reuse the Prometheus step/interval calculation ([#254](https://github.com/grafana/grafana-prometheus-datasource/pull/254))

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
