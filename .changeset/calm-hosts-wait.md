---
'grafana-prometheus-datasource': minor
---

Add an optional limit on concurrent outgoing requests per destination host. Set `max_concurrent_requests_per_host` in the `[plugin.prometheus]` section of the Grafana configuration. The limit is off by default.
