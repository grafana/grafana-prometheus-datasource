# Chunked Prometheus query PoC

This streams the supported Prometheus `query_range` response subset through the
external plugin's `QueryChunkedData` gRPC endpoint. In Grafana 13.1 and later,
the datasource can also use it for normal Explore and dashboard requests when
the datasource-level **Chunked queries (experimental)** option is enabled.

## Requirements

- Grafana 13.1 or later.
- The external Prometheus plugin selected with `[plugin.prometheus] as_external = true`.
- `datasource.useNewCRUDAPIs`, `datasources.chunkedQueryStreaming`, and
  `grafanaAPIServerWithExperimentalAPIs` enabled. The repository's
  `docker-compose.yaml` enables these flags.

## Start the PoC

From the repository root:

```sh
mage -v
docker compose up --build
```

Provision or select a Prometheus datasource, then request the plugin-specific
query endpoint with JSONL negotiation:

```sh
curl --no-buffer --fail-with-body \
  -H 'Accept: text/jsonl' \
  -H 'Content-Type: application/json' \
  -u admin:admin \
  'http://localhost:3000/apis/prometheus.datasource.grafana.app/v0alpha1/namespaces/default/datasources/<DATASOURCE_UID>/query' \
  --data @query.json
```

Genuine streaming produces multiple newline-delimited events. The first data
event must arrive while the upstream `query_range` response is still open; the
same `(refId, frameId)` pair repeats as later sample batches append to that
frame. Calling the ordinary `/api/ds/query` endpoint exercises buffered
`QueryData`, not this PoC.

## Production opt-in and fallback

Chunked routing requires all of the following:

- a stable Grafana version 13.1 or newer;
- the datasource-level opt-in;
- the feature toggles listed above; and
- a request containing only supported range targets.

Supported requests progressively emit complete accumulated frame snapshots while
the response is still being read. The normal cache, transform, and query
tracking pipeline runs after each snapshot.

Instant, exemplar, `Both`, heatmap, SQL/flattened, non-range, mixed-datasource,
expression, and public-dashboard requests use the ordinary buffered query path.
A 404 or 406 before the first JSONL frame also falls back once to the buffered
path, which supports mixed Grafana/plugin deployments. Errors after a frame is
received are surfaced directly and are not replayed, avoiding duplicate queries
or mixed partial responses. Native histograms are detected by the backend only,
so they follow this latter error behaviour.

`BackendSrv.chunked()` intentionally bypasses portions of Grafana's regular
fetch queue. The plugin reproduces the request payload, cancellation, and
user-visible response semantics needed by this transport, but does not depend
on Grafana private queue implementation details.

## Browser debug consumer

The saved datasource configuration page contains a collapsed **Experimental
chunked query consumer** section. It is an opt-in diagnostic UI that submits one
supported range query to the same plugin-specific endpoint, consumes partial
UTF-8/JSONL boundaries, and accumulates repeated `(refId, frameId)` events. It
shows first-frame time, received chunk count, and the accumulated frames.

It remains separate from the production response state and is intended for
transport diagnostics.

## Supported subset

- Successful canonical envelopes with `status`, then `data`.
- `data.resultType == "matrix"` followed by `data.result`.
- Range-only float samples, with each series ordered as `metric`, then
  `values`.

The handler returns a per-`refID` stream error for instant, exemplar, native
histogram, SQL/flattened, reordered, malformed, or truncated responses. It
does not fall back to `QueryData`.

## Compare buffered and chunked conversion

The conversion benchmark compares the existing buffered `parseResponse` path
with `streamMatrix`. Both variants fetch a fixture through the existing
file-backed `query_range` HTTP handler. The chunked writer discards frames
after encoding so it does not recreate buffered memory use.

Run these commands from `pkg/promlib`:

```sh
export BENCH_DIR="${TMPDIR:-/tmp}/prom-query-json-bench"
mkdir -p "$BENCH_DIR/results"

# Many moderate series.
go run ./experiments/queryresponsejson/cmd/generate \
  -output "$BENCH_DIR/query-range-many-64m.json" \
  -min-bytes $((64 * 1024 * 1024)) -samples-per-series 128

# A single large series, to detect accidental whole-series buffering.
go run ./experiments/queryresponsejson/cmd/generate \
  -output "$BENCH_DIR/query-range-huge-64m.json" \
  -min-bytes $((64 * 1024 * 1024)) -samples-per-series 4000000

go test -c -o "$BENCH_DIR/results/querydata.test" ./querydata
for shape in many huge; do
  for variant in buffered chunked; do
    for run in 1 2 3 4 5 6; do
      GOMAXPROCS=1 PROM_CHUNKED_FIXTURE="$BENCH_DIR/query-range-$shape-64m.json" \
        /usr/bin/time -l "$BENCH_DIR/results/querydata.test" \
        -test.run '^$' -test.bench "^BenchmarkResponseConversion/$variant$" \
        -test.benchtime=1x -test.count=1 -test.benchmem \
        | tee -a "$BENCH_DIR/results/$variant-$shape-64m.txt"
    done
  done
done
```

`ns/op`, `B/op`, and `allocs/op` describe conversion work. `/usr/bin/time -l`
reports the process RSS. The candidate also reports `first-chunk-us` and
`first-chunk-bytes`; a value below the fixture size confirms a data frame was
written before the upstream body reached EOF. See `RESULTS.md` for a recorded
run and measurement limitations.
