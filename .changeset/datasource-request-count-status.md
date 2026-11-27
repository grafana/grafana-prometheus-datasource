---
'grafana-prometheus-datasource': patch
---

Count a query whose response holds an error as `status="error"` or `status="cancelled"` in `grafana_prometheus_plugin_backend_request_count`, not as `status="ok"`. Label an error that the Prometheus server returns `errorSource="database"`, or `errorSource="external"` for an authentication status, not `errorSource="plugin"`. Label a cancelled query `errorSource="none"`.
