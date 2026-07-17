# Chunked Prometheus query PoC

This PoC streams the supported Prometheus `query_range` response subset through
the external plugin's `QueryChunkedData` gRPC endpoint. It is not used by the
normal Grafana Explore or dashboard query path.

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
