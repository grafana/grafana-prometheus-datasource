---
'grafana-prometheus-datasource': patch
---

Return an instant query that shows as a table as one frame, not one frame per series. The table is the same as before, and a table with many series uses much less memory in the plugin and in Grafana.
