---
'promlib': patch
'grafana-prometheus-datasource': patch
---

Fix: Stop rejecting loosely-typed jsonData. Since promlib v0.0.13 a datasource provisioned through the API, Terraform or an operator with an off-spec value — `"true"` for a boolean, `"1000"` or `1000.0` for a number — failed to load, and every query, health check and metric lookup against it errored. Such values are now coerced where the type can be read and ignored where it cannot, each logging a warning. `timeInterval`, `queryTimeout` and `httpMethod` are unchanged and still reject a wrong type.

**Breaking (Go API):** the affected `models.PromOptions` fields change from `string`/`bool`/`float64`/`*int64` to named lenient types (`LenientBool`, `LenientString`, `LenientFloat64`, `LenientInt64`, `LenientExemplarTraceIDDestinations`) with the same underlying types and JSON encoding. Literals still assign and compare as before, but passing one to a `string`, `bool` or `float64` parameter now needs an explicit conversion, e.g. `string(opts.CustomQueryParameters)`.
