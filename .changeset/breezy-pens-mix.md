---
'@grafana/prometheus': patch
---

Add optional `uiOptions` and `formatOptions` props to PromQueryBuilderOptions. Defaults preserve current behavior, existing callers see no change.
