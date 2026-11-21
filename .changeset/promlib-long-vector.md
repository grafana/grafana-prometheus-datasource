---
'promlib': patch
---

Return an instant vector as one numeric-long frame when the query sets `longVector`, with null in a label column for a series that lacks the label. Alert queries ignore `longVector`. They return a long frame only when Grafana alerting sets `alertingNumericLong`, and a vector that holds a native histogram sample then keeps one frame per series.
