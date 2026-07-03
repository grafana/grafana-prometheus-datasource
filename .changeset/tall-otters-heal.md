---
'@grafana/prometheus': patch
---

Preserve non-`le` labels in heatmap frame names. When a histogram is queried with grouping labels (e.g. `sum by (le, foo) (some_metric_bucket)`) and rendered as a Heatmap, merged frames were named after the lowest `le` bucket value and dropped the other labels, so the legend showed `0.005`, `0.01`, … for every grouping instead of `{foo="bar"}`, `{foo="baz"}`. The merged-frame name is now built from the non-`le` labels so each partition reflects its label set.
