---
'promlib': patch
---

Return an instant vector as one numeric-long frame when the query sets `longVector`, with null in a label column for a series that lacks the label. Alert queries ignore `longVector` and keep one frame per series.
