---
'promlib': patch
---

**Breaking (Go API):** `models.PromOptions` now matches the datasource config schema in `pkg/schema/dsconfig.json`.

- Removed the embedded `models.DataSourceJsonData` type. It mirrored the `@grafana/data` base interface that every datasource extends, so it carried fields Prometheus does not support.
  - **Deleted entirely** (not settable on Prometheus, and never read by this backend): `AuthType`, `DefaultRegion`, `Profile`, `AlertmanagerUID`, `DisableGrafanaCache`.
  - **Kept**, now declared directly on `PromOptions` with unchanged names and JSON keys: `ManageAlerts`, `AllowAsRecordingRulesTarget`.
- `PrometheusType`, `CacheLevel` and `DefaultEditor` are now the named types `PromApplication`, `PrometheusCacheLevel` and `QueryEditorMode` instead of `string`. Assigning string literals still compiles; passing these fields to a `string` parameter now needs an explicit conversion, e.g. `string(opts.PrometheusType)`.
- Added the SDK-managed jsonData fields `timeout`, `keepCookies`, `tlsAuth`, `serverName`, `tlsAuthWithCACert`, `tlsSkipVerify` and `enableSecureSocksProxy`.

Serialization is unchanged; no jsonData key was renamed.
