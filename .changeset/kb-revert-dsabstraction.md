---
'grafana-prometheus-datasource': patch
---

Remove experimental, feature-gated schema/SQL-abstraction integration from promlib. This code was never enabled by default and had no user-facing effect.
