---
'grafana-prometheus-datasource': patch
---

Fix: force GET method for /api/v1/status/buildinfo to prevent 405 errors on POST-configured datasources
