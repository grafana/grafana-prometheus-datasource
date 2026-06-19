---
'grafana-prometheus-datasource': patch
---

Prometheus: Fix "metric name must not be set twice" when an adhoc filter on `__name__` is combined with a query that already sets the metric name as a prefix. The metric prefix is now folded into the `__name__` matcher so the name is specified exactly once. Fixes grafana/grafana#126518.
