---
'grafana-prometheus-datasource': patch
---

Fix: Convert 'one of' ad hoc filters for label lookups. Multi-value `=|` / `!=|` ad hoc filters previously broke `getTagKeys` / `getTagValues` with a Prometheus parse error and silently dropped all but the first selected value.
