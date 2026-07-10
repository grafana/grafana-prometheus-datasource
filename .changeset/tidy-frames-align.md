---
'@grafana/prometheus': patch
---

Fix incremental querying emitting DataFrames whose `length` did not match the trimmed field values, producing invalid frames that could crash downstream consumers such as the heatmap panel.
