---
'grafana-prometheus-datasource': patch
---

Send resource requests through `DataSourceWithBackend`. `metadataRequest` now uses `getResource`/`postResource` instead of building the legacy `/api/datasources/uid/<uid>/resources` URL by hand, so resource calls follow whichever resource API the Grafana instance is configured to use. Its response shape is unchanged. The unused `_request` method has been removed.
