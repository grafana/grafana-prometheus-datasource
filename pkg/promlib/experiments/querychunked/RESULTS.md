# Chunked conversion results

## Run metadata

- Date: 2026-07-18.
- Host: Apple M4 Pro, macOS Darwin arm64.
- Go: 1.26.4; `GOMAXPROCS=1`.
- Six fresh processes per fixture and variant.
- Fixture server: the existing file-backed `query_range` handler, running
  in-process with the benchmark client.

## Latest results: JSON-encoded chunks

These runs use the SDK JSON chunk writer, so they include the allocation and
CPU cost of serializing every emitted frame. Each value is the mean of six
fresh processes with `GOMAXPROCS=1`; RSS is process peak from `/usr/bin/time -l`.

| Fixture | Buffered time / peak RSS | Chunked time / peak RSS | Chunked first chunk | Chunked GC cycles / pause |
| --- | --- | --- | --- | --- |
| 256 MiB, many series | 1.11 s / 776 MB | 2.77 s / 47 MB | 0.36 ms, 3.9 KB | 413 / 8.4 ms |
| 303 MiB, one huge series | 1.01 s / 646 MB | 2.74 s / 40 MB | 0.50 ms, 25.4 KB | 865 / 14.5 ms |
| 1 GiB, many series | 4.34 s / 3.05 GB | 10.66 s / 82 MB | 0.35 ms, 3.9 KB | 855 / 15.7 ms |
| 1.1 GiB, one huge series | 3.53 s / 1.93 GB | 10.10 s / 42 MB | 0.50 ms, 25.4 KB | 3,166 / 53.7 ms |
| 2.0 GiB, many series | 9.79 s / 4.43 GB | 21.55 s / 144 MB | 0.42 ms, 3.9 KB | 1,147 / 22.5 ms |
| 2.1 GiB, one huge series | 6.96 s / 3.35 GB | 19.48 s / 46 MB | 0.63 ms, 25.4 KB | 6,056 / 107.6 ms |

The largest JSON chunks were 3.5 KB for many-series fixtures and 23.5 KB for
huge-series fixtures. Chunking kept peak live memory approximately bounded as
the fixture grew, but it increased total allocation substantially: 19.0 GB
allocated for the 2 GiB many-series fixture and 19.6 GB for the 2.1 GiB
huge-series fixture. That allocation churn explains the higher GC counts and
slower throughput.

## Earlier results: converter-only baseline

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

## Earlier streaming measurements

| Fixture | First non-empty chunk | Upstream bytes consumed |
| --- | ---: | ---: |
| Many series | 38 µs mean | 3,914 bytes |
| One huge series | 121 µs mean | 25,417 bytes |

Both values are far below the fixture sizes, so the converter writes a frame
before upstream EOF. The huge-series case demonstrates the important bound:
streaming live RSS remained near 32 MB rather than retaining the series'
millions of samples.

## Earlier converter-only interpretation

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
