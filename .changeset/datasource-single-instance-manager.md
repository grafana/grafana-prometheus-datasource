---
'grafana-prometheus-datasource': patch
---

Serve each data source from one instance cache, so a data source no longer adds a second cache, a cleanup goroutine and a second count to the `plugins_active_instances` gauge. Add `NewServiceFactory` for callers that cache instances themselves, and close an instance's idle connections when the SDK evicts or replaces it.
