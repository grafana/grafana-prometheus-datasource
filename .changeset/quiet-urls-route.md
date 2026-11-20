---
'@grafana/prometheus': patch
---

Build the Search API resource URL with `buildResourcesDatasourceUrl` so it follows Grafana's datasource API routing, falling back to the legacy URL on older Grafana runtimes. Also send the datasource request headers (`X-Plugin-Id`, `X-Datasource-Uid`) with these requests.
