---
'promlib': patch
---

Fix GetSuggestions silently dropping X-Grafana-Cache so suggestion responses now respect the caller's cache-control directive.
