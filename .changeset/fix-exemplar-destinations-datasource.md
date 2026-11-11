---
'grafana-prometheus-datasource': patch
---

Fix config editor crash when exemplarTraceIdDestinations is provisioned as a non-array value. The value is now ignored, matching the backend, and a warning is shown.
