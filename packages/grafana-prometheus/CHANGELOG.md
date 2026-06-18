# Changelog

## 13.1.6

🐛 Add optional `uiOptions` and `formatOptions` props to PromQueryBuilderOptions. Defaults preserve current behavior, existing callers see no change.

🐛 Add unit coverage for the Monaco completion DataProvider (queryMetricNames regex/escape/error handling, metricNamesToMetrics, getHistory). Test-only, no user-facing change. ([#194](https://github.com/grafana/grafana-prometheus-datasource/pull/194))

🐛 Export applyModifyQuery as a standalone helper so consumers can apply QueryFixActions without instantiating PrometheusDatasource.

🐛 Remove dead client-side metric-name filtering from the code-editor autocomplete (internal cleanup, no user-facing change). ([#193](https://github.com/grafana/grafana-prometheus-datasource/pull/193))

🐛 Fix running frontend unit tests ([#192](https://github.com/grafana/grafana-prometheus-datasource/pull/192))

🐛 Monaco completion provider: include the offending value in NeverCaseError and replace magic numbers with named constants (internal cleanup, no user-facing change). ([#196](https://github.com/grafana/grafana-prometheus-datasource/pull/196))

🐛 Add unit coverage for query validation interpolated-query trace-back and out-of-range issue boundaries. Test-only, no user-facing change. ([#195](https://github.com/grafana/grafana-prometheus-datasource/pull/195))

## 13.1.5

🐛 Add max samples processed warning/error thresholds to the data source advanced settings, appended as query parameters on outbound Prometheus requests.

## 13.1.4

🐛 Fix Type query option misalignment in the query editor options panel on Grafana 13.1.0+

## 13.1.3

- Bundle `@grafana/assistant` into the library dist.

## (2024-02-16)

First public release. This release provides Prometheus exports in Grafana. Please be aware this is in the alpha state and there is likely to be breaking changes.
