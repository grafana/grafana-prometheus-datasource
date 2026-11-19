---
'grafana-prometheus-datasource': patch
---

Decode Mimir's protobuf query responses. When the `prometheus.mimir-protobuf-responses` feature flag is on for a request, instant and range queries accept `application/vnd.mimir.queryresponse+protobuf` with JSON as the fallback, and the protobuf response is decoded one series at a time into the same frames as the JSON response. The flag is read only from an OFREP host endpoint, so it is off on self-managed Grafana. Datasources that request query stats keep JSON.
