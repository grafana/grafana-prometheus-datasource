---
'@grafana/prometheus': minor
'promlib': minor
---

Add experimental support for the Prometheus/Mimir NDJSON streaming search API (`/api/v1/search/*`) for fuzzy, scored, server-side autocomplete. Gated behind a per-datasource `enableSearchApi` toggle and transported over a persistent per-session Grafana Live channel. Falls back to the existing labels/series endpoints when the stream is unavailable.
