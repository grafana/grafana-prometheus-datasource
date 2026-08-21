---
'@grafana/prometheus': minor
---

Send resource requests through `DataSourceWithBackend`. `metadataRequest` now uses `getResource`/`postResource` instead of building the legacy `/api/datasources/uid/<uid>/resources` URL by hand, so resource calls follow whichever resource API the Grafana instance is configured to use. Two breaking changes for direct consumers: `metadataRequest` now resolves with the response body instead of a `FetchResponse` (use `res.data` where you used `res.data.data`), and the unused `_request` method has been removed.
