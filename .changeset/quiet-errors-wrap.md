---
'grafana-prometheus-datasource': patch
---

Keep the error source of failed resource and Search API requests. Timeouts, cancellations, connection errors and other downstream errors from these requests are now reported as downstream, not as plugin errors.
