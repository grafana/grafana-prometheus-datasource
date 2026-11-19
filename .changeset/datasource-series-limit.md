---
'grafana-prometheus-datasource': patch
---

Add a series limit. When Grafana sends `GF_SERIES_LIMIT` in the plugin configuration, a query result with more series than the limit fails with a downstream error before its frames are built.
