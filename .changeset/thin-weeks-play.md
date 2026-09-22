---
'promlib': patch
---

Fix: Stop rejecting loosely-typed jsonData (e.g. `"true"` for a boolean, `"1000"` for a number) so datasources provisioned with off-spec values load instead of failing every query and health check. `timeInterval`, `queryTimeout` and `httpMethod` still reject a wrong type.

**Breaking (Go API):** affected `models.PromOptions` fields move from plain `string`/`bool`/`float64`/`*int64` to named lenient types with the same JSON encoding. Passing one to a `string`/`bool`/`float64` parameter now needs an explicit conversion. See [#310](https://github.com/grafana/grafana-prometheus-datasource/pull/310) for details.
