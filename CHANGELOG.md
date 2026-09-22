# grafana-prometheus-datasource

## 13.2.1

🐛 Improve Search API ranking and bound streamed response memory

🐛 Use the Search API for metric and label discovery

## 13.2.0

🐛 Support PromQL anchored and smoothed range selectors in the query builder, code editor, scope filtering, and label suggestions. ([#343](https://github.com/grafana/grafana-prometheus-datasource/pull/343))

⚙️ Chore: align Grafana peer ranges to >=12.3.0 so they match grafanaDependency and the required @grafana/i18n peer ([#340](https://github.com/grafana/grafana-prometheus-datasource/pull/340))

🐛 Fix config editor crash when customQueryParameters is provisioned as a non-string value. ([#347](https://github.com/grafana/grafana-prometheus-datasource/pull/347))

🐛 Default to POST for POST-friendly metadata endpoints (e.g. /api/v1/labels) when no HTTP method is configured, matching the config editor's default. ([#322](https://github.com/grafana/grafana-prometheus-datasource/pull/322))

🐛 Recognise native-histogram trim operators (</, >/) in the PromQL query editor by bumping @prometheus-io/lezer-promql to 0.313.3 ([#338](https://github.com/grafana/grafana-prometheus-datasource/pull/338))

🐛 Fall back to standard Prometheus discovery when the Search API is unavailable ([#348](https://github.com/grafana/grafana-prometheus-datasource/pull/348))

🐛 Parse datasource jsonData once per instance construction instead of independently in the transport, query handler, and resource handler. Reduces redundant parsing/logging. ([#341](https://github.com/grafana/grafana-prometheus-datasource/pull/341))

🐛 Add NDJSON search stream parser and error taxonomy ([#337](https://github.com/grafana/grafana-prometheus-datasource/pull/337))

🐛 Add the typed Search API client for metric and label discovery ([#342](https://github.com/grafana/grafana-prometheus-datasource/pull/342))

🐛 Add the chunked transport bridge for the Search API stream and require @grafana/runtime >=11.6.0 ([#338](https://github.com/grafana/grafana-prometheus-datasource/pull/338))

🐛 Fix: Stop rejecting loosely-typed jsonData (e.g. `"true"` for a boolean, `"1000"` for a number) so datasources provisioned with off-spec values load instead of failing every query and health check. `timeInterval`, `queryTimeout` and `httpMethod` still reject a wrong type. ([#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310))

**Breaking (Go API):** affected `models.PromOptions` fields move from plain `string`/`bool`/`float64`/`*int64` to named lenient types with the same JSON encoding. Passing one to a `string`/`bool`/`float64` parameter now needs an explicit conversion. See [#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310) for details. ([#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310))

🐛 Surface Mimir query stats in the Inspector's Stats tab ([#319](https://github.com/grafana/grafana-prometheus-datasource/pull/319))

🐛 Adapt the Search API client to the resource client contract ([#344](https://github.com/grafana/grafana-prometheus-datasource/pull/344))

🐛 Implement Search API toggle in configuration editor ([#350](https://github.com/grafana/grafana-prometheus-datasource/pull/))

🐛 Request gzip for resource calls to prevent failures caused by forwarding the browser's Accept-Encoding to upstream servers ([#334](https://github.com/grafana/grafana-prometheus-datasource/pull/334))

## 13.1.9

🐛 Add an internal, experimental PromQL coauthoring capability for the Monaco code editor, including its Grafana Core exposed-surface integration. ([#308](https://github.com/grafana/grafana-prometheus-datasource/pull/308))

🐛 Update broken dependency tree ([#328](https://github.com/grafana/grafana-prometheus-datasource/pull/328))

## 13.1.8

⚙️ Bump grafana-plugin-sdk-go to v0.295.0, which sets a user agent on all outgoing HTTP requests ([#302](https://github.com/grafana/grafana-prometheus-datasource/pull/302))

⚙️ Bump grafana-plugin-sdk-go v0.296.1 ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 fix(QueryCache): cache relative-offset queries, not just 'now' ([#285](https://github.com/grafana/grafana-prometheus-datasource/pull/285))

🐛 fix(QueryBuilder): prevent sum by second label from reverting on add ([#300](https://github.com/grafana/grafana-prometheus-datasource/pull/300))

🐛 Introduce more devenv options for easier and more comprehensive development ([#301](https://github.com/grafana/grafana-prometheus-datasource/pull/301))

⚙️ Chore: Bump vulnerable frontend dependencies (js-cookie, serialize-javascript, ws, uuid, form-data, brace-expansion, fast-uri, ip-address) ([#307](https://github.com/grafana/grafana-prometheus-datasource/pull/307))

🐛 Removing abstraction related logic. Abstraction PoC has concluded, cleaning up relevant code. ([#318](https://github.com/grafana/grafana-prometheus-datasource/pull/318))

🐛 Send resource requests through `DataSourceWithBackend`. `metadataRequest` now uses `getResource`/`postResource` instead of building the legacy `/api/datasources/uid/<uid>/resources` URL by hand, so resource calls follow whichever resource API the Grafana instance is configured to use. Its response shape is unchanged. The unused `_request` method has been removed.

🐛 Improve numeric value parsing performance ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Bump go v1.26.7 ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Improve histogram parsing performance ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Add search api support ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Improve changeset creation ([#289](https://github.com/grafana/grafana-prometheus-datasource/pull/289))

🐛 Fix: Convert 'one of' ad hoc filters for label lookups. Multi-value `=|` / `!=|` ad hoc filters previously broke `getTagKeys` / `getTagValues` with a Prometheus parse error and silently dropped all but the first selected value. ([#297](https://github.com/grafana/grafana-prometheus-datasource/pull/297))

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

🐛 Fix forwarding Grafana HTTP headers (X-Dashboard-*, X-Grafana-*) to upstream database ([#229](https://github.com/grafana/grafana-prometheus-datasource/pull/229))

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
