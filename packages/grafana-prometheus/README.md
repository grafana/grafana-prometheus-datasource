# Grafana Prometheus NPM Library

> **@grafana/prometheus is currently in ALPHA**.

@grafana/prometheus is a collection of components used to build a Prometheus data source plugin in [Grafana](https://github.com/grafana/grafana).

See [package source](https://github.com/grafana/grafana/tree/main/packages/grafana-prometheus) for more details.

## Installation

`yarn add @grafana/prometheus`

`npm install @grafana/prometheus`

## Extended range selectors

The query builder supports **Anchored rate**, **Anchored increase**, **Anchored delta**, **Anchored changes**,
**Anchored resets**, **Smoothed rate**, **Smoothed increase**, and **Smoothed delta** under Range functions.
Code mode also recognizes the modifier syntax and offers completions after supported selectors.

```promql
increase(http_requests_total[5m] anchored)
rate(http_requests_total[5m] smoothed)
```

`anchored` uses observed samples at the range boundaries without extrapolation or interpolation. `smoothed`
interpolates boundary values using surrounding samples. Because smoothing needs samples after the end of the
range, recent results can be underestimated; recording and alerting rules should use a rule group `query_offset`.

The Prometheus server must support extended range selectors and run with
`--enable-feature=promql-extended-range-selectors`. Supported sample types depend on the server version.
Extended range selectors do not support subqueries. Instant selectors with `smoothed`, and modified selectors
combined with `offset` or `@`, can be used in Code mode; Builder reports a conversion error for those forms.
See the [Prometheus extended range selector documentation](https://prometheus.io/docs/prometheus/latest/feature_flags/#extended-range-selectors).
