---
'@grafana/prometheus': patch
---

Default to POST for POST-friendly metadata endpoints (e.g. /api/v1/labels) when no HTTP method is configured, matching the config editor's default.
