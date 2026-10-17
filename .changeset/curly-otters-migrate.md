---
'@grafana/prometheus': minor
---

Add `getDrilldownMigrationUsage` datasource capability: classifies whether a template variable used in a query expression corresponds to an ad hoc filter, a group-by label, or is unsafe to migrate. Powers the drilldown migration assistant suggestion in Grafana core.
