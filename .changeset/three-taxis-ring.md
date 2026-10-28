---
'grafana-prometheus-datasource': patch
---

Always send ad hoc group by keys to the backend. They were gated on the removed `groupByVariable` and `dashboardUnifiedDrilldownControls` feature toggles, so group by stopped applying to Prometheus queries.
