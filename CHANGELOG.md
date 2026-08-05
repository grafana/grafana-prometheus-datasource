# grafana-prometheus-datasource

## 13.1.7

🐛 Use npm as package manager ([#272](https://github.com/grafana/grafana-prometheus-datasource/pull/272))

⚙️ Bump grafana-plugin-sdk-go to v0.294.0, enabling diagnostic bundle HTTP capture ([#288](https://github.com/grafana/grafana-prometheus-datasource/pull/288))

🐛 Fix: force GET method for /api/v1/status/buildinfo to prevent 405 errors on POST-configured datasources ([#293](https://github.com/grafana/grafana-prometheus-datasource/pull/293))

## 13.1.6

🐛 Dependency updates ([#91](https://github.com/grafana/grafana-prometheus-datasource/pull/91))

⚙️ Chore: Remove moment and moment-timezone deps ([#264](https://github.com/grafana/grafana-prometheus-datasource/pull/264))

🐛 Fix: fetch metrics on series limit blur instead of change ([#221](https://github.com/grafana/grafana-prometheus-datasource/pull/221))

🐛 Add hover titles for label filter operators ([#91](https://github.com/grafana/grafana-prometheus-datasource/pull/91))

⚙️ Chore: Remove moment and moment-timezone deps ([#264](https://github.com/grafana/grafana-prometheus-datasource/pull/264))

🐛 Revert bundling of Assistant ([#91](https://github.com/grafana/grafana-prometheus-datasource/pull/91))

🐛 Add interaction tracking for Query Explorer and Metrics Browser ([#238](https://github.com/grafana/grafana-prometheus-datasource/pull/238))

🐛 Query builder: associate each parameter label with its input so screen readers announce the field (a11y) ([#76](https://github.com/grafana/grafana-prometheus-datasource/pull/76))

🐛 Preserve non-`le` labels in heatmap frame names. When a histogram is queried with grouping labels (e.g. `sum by (le, foo) (some_metric_bucket)`) and rendered as a Heatmap, merged frames were named after the lowest `le` bucket value and dropped the other labels, so the legend showed `0.005`, `0.01`, … for every grouping instead of `{foo="bar"}`, `{foo="baz"}`. The merged-frame name is now built from the non-`le` labels so each partition reflects its label set. ([#186](https://github.com/grafana/grafana-prometheus-datasource/pull/186))

🐛 Fix incremental querying emitting DataFrames whose `length` did not match the trimmed field values, producing invalid frames that could crash downstream consumers such as the heatmap panel. ([#241](https://github.com/grafana/grafana-prometheus-datasource/pull/241))

## 13.1.5

🐛 Updating CI/CD workflows ([#228](https://github.com/grafana/grafana-prometheus-datasource/pull/228))

🐛 Fix: Strip stale encoding headers and forward only allowlisted Grafana headers upstream ([#232](https://github.
com/grafana/grafana-prometheus-datasource/pull/232))

🐛 Fix: Forward caching headers for suggestions endpoint ([#234](https://github.com/grafana/grafana-prometheus-datasource/pull/234))

## 13.1.4

🐛 Fix forwarding Grafana HTTP headers (X-Dashboard-_, X-Grafana-_) to upstream database ([#229](https://github.com/grafana/grafana-prometheus-datasource/pull/229))

## 13.1.3

🐛 Bump grafana-plugin-sdk-go version to v0.292.2 ([#226](https://github.com/grafana/grafana-prometheus-datasource/pull/226))

## 13.1.2

🐛 Bump go version to v1.26.4

🐛 Harden security of dependencies

## 13.1.1

🐛 Enable scheduled task creation in Crowdin workflow

🐛 Add keywords in plugin.json

🐛 disable yarn scripts

🐛 Add publish-and-deploy job

🐛 Add more rc files to disable running scripts

🐛 Implement i18n support

🐛 Introduce changesets

🐛 Update golangci-lint-version to 2.11.0 in push workflow

🐛 Bump go version to v1.26.3
