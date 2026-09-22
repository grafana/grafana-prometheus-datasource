# Prometheus Search API lifecycle

The Prometheus Search API is an experimental, opt-in discovery path for metric
names, label names, and label values. Enable it with `enableSearchApi` in the
datasource configuration.

It requires:

- Grafana 11.6 or later, which provides the chunked resource-response API.
- Prometheus 3.13 or later with `--enable-feature=search-api`, or a Mimir build
  with `-querier.experimental-search-api-enabled`.

## Request flow

The frontend sends search requests through the datasource resource route. The
backend forwards the upstream NDJSON response without buffering it, and the
frontend renders batches as they arrive where the UI supports progressive
results.

The configured series limit still applies. Search requests cap an unlimited or
higher limit at the upstream Search API maximum of 10,000 results and request
100 records per batch by default.

## Capability fallback

The client falls back to standard Prometheus discovery only when the Search API
is unavailable:

- the upstream error body has `errorType: "unavailable"`;
- the route returns HTTP 404, 405, or 501; or
- the Grafana host does not provide chunked resource responses.

Other failures, including timeouts, network errors, and HTTP 500 responses
without the `unavailable` error type, remain visible to the caller.

Once unavailability is detected, the datasource instance remembers it and uses
standard discovery for later requests. Saving the datasource creates a new
instance, which probes the Search API again.

## Local verification

Run `npm run server:search-api` and use the provisioned
`prometheus-search-api` datasource. The `prometheus-direct` datasource in the
same environment provides the standard-discovery comparison path.

Verify metric, label-name, and label-value completion in the code editor, the
metric combobox, and the metrics explorer. Then restart Prometheus without
`--enable-feature=search-api` and confirm the first capability failure switches
the datasource to standard discovery without repeated Search API requests.
