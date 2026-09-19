---
'grafana-prometheus-datasource': patch
---

Parse datasource jsonData once per instance construction instead of independently in the transport, query handler, and resource handler. Reduces redundant parsing/logging.
