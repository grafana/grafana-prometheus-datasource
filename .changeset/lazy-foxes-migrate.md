---
'grafana-prometheus-datasource': minor
---

Add `getFiltersMigrationUsage` datasource capability: classifies whether a template variable used in a query expression corresponds to an ad hoc filter, a group-by label, or is unsafe to migrate. Powers the filters migration assistant suggestion in Grafana core.
