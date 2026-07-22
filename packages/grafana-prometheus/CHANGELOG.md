# Changelog

## 13.1.8

🐛 Fix: fetch metrics on series limit blur instead of change ([#221](https://github.com/grafana/grafana-prometheus-datasource/pull/221))

🐛 Add hover titles for label filter operators ([#91](https://github.com/grafana/grafana-prometheus-datasource/pull/91))

⚙️ Chore: Remove moment and moment-timezone deps ([#264](https://github.com/grafana/grafana-prometheus-datasource/pull/264))

🐛 Add interaction tracking for Query Explorer and Metrics Browser ([#238](https://github.com/grafana/grafana-prometheus-datasource/pull/238))

🐛 Query builder: associate each parameter label with its input so screen readers announce the field (a11y) ([#76](https://github.com/grafana/grafana-prometheus-datasource/pull/76))

🐛 Preserve non-`le` labels in heatmap frame names. When a histogram is queried with grouping labels (e.g. `sum by (le, foo) (some_metric_bucket)`) and rendered as a Heatmap, merged frames were named after the lowest `le` bucket value and dropped the other labels, so the legend showed `0.005`, `0.01`, … for every grouping instead of `{foo="bar"}`, `{foo="baz"}`. The merged-frame name is now built from the non-`le` labels so each partition reflects its label set. ([#186](https://github.com/grafana/grafana-prometheus-datasource/pull/186))

🐛 Fix incremental querying emitting DataFrames whose `length` did not match the trimmed field values, producing invalid frames that could crash downstream consumers such as the heatmap panel. ([#241](https://github.com/grafana/grafana-prometheus-datasource/pull/241))

## 13.1.7

🐛 Add a `disableTypeBoth` flag to `PromQueryBuilderUIOptions` so embedders can remove the "Both" option from the query Type selector. ([#215](https://github.com/grafana/grafana-prometheus-datasource/pull/215))

🐛 Export resource clients (`LabelsApiClient`, `SeriesApiClient`, `BaseResourceClient`, `ResourceApiClient`) ([#215](https://github.com/grafana/grafana-prometheus-datasource/pull/215))

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
