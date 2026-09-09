---
'grafana-prometheus-datasource': patch
---

Pin the upstream Accept-Encoding for resource calls to gzip in QueryResource, so the browser's Accept-Encoding no longer leaks upstream and zstd-encoded responses can no longer cause 500s
