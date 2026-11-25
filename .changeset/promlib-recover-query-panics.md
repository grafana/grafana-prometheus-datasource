---
'promlib': patch
---

Return a query error instead of stopping the plugin process when a query panics, and count it in `grafana_prometheus_plugin_backend_query_panic_count`. Each query, and each of its instant, range and exemplar requests, runs on a goroutine that the SDK's panic recovery does not reach.
