---
'grafana-prometheus-datasource': patch
---

Ignore custom Accept-Encoding headers and error on undecodable resource responses. `utils.Decode`/`NewDecodingReader` no longer decode `deflate` or `br` — resource calls only ever request gzip, so any other encoding now surfaces as an error instead of being silently decoded.
