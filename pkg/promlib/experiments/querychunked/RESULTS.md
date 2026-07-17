# Chunked conversion results

## Run metadata

- Date: 2026-07-18.
- Host: Apple M4 Pro, macOS Darwin arm64.
- Go: 1.26.4; `GOMAXPROCS=1`.
- Six fresh processes per fixture and variant.
- Fixture server: the existing file-backed `query_range` handler, running
  in-process with the benchmark client.

## Mean results

| Fixture | Variant | Time | Allocated bytes | Allocations | Peak RSS |
| --- | --- | ---: | ---: | ---: | ---: |
| 64 MiB, 20,058 series × 128 samples | Buffered | 283.7 ms | 259.1 MB | 3.82 M | 205 MB |
| 64 MiB, 20,058 series × 128 samples | Chunked | 292.5 ms | 343.1 MB | 3.92 M | 31.8 MB |
| 106 MiB, 1 series × 4,000,000 samples | Buffered | 414.2 ms | 843.2 MB | 4.04 M | 342 MB |
| 106 MiB, 1 series × 4,000,000 samples | Chunked | 417.0 ms | 607.2 MB | 4.21 M | 31.8 MB |

The 64 MiB many-series fixture uses SHA-256
`371b74e28e649d76d88144699ccd7ec9885115f2ca9b1af099ab9bdad36677e2`.
The 106 MiB huge-series fixture uses SHA-256
`4c4eb9f43e03bf2afda3156ee11aeac7146788b3b013877d992f2b853f0d5683`.

## Streaming measurements

| Fixture | First non-empty chunk | Upstream bytes consumed |
| --- | ---: | ---: |
| Many series | 38 µs mean | 3,914 bytes |
| One huge series | 121 µs mean | 25,417 bytes |

Both values are far below the fixture sizes, so the converter writes a frame
before upstream EOF. The huge-series case demonstrates the important bound:
streaming live RSS remained near 32 MB rather than retaining the series'
millions of samples.

## Interpretation

- Chunking reduced peak RSS by about 84% for many series and 91% for the huge
  series fixture.
- The huge-series candidate allocated 28% fewer bytes, with comparable total
  time (+0.7%).
- The many-series candidate allocated 32% more bytes and ran 3.1% slower. Its
  per-series frame work needs optimization before treating it as a general
  throughput win.

These are converter-level measurements, not a full external-plugin transport
benchmark: they exclude Grafana's gRPC and JSONL bridge, network latency, and
the fixture server process. Raw benchmark and `/usr/bin/time` logs are stored
outside the repository under `$BENCH_DIR/results`.
