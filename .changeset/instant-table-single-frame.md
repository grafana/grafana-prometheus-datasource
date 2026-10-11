---
'grafana-prometheus-datasource': patch
'@grafana/prometheus': patch
'promlib': patch
---

Return instant table queries as one frame instead of one frame per series. Large table panels used several times more memory after Prometheus moved out of core, and could get the Grafana container OOM-killed.
