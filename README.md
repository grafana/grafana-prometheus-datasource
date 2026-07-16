# Prometheus data source for Grafana

> **Note**: This core plugin was extracted from the
> [grafana/grafana](https://github.com/grafana/grafana) repository and is now
> developed and released from this repository.

## Overview

[Prometheus](https://prometheus.io/) is an open-source time series database and
alerting system. The Prometheus data source plugin lets Grafana query, visualize,
and alert on metrics stored in Prometheus or any Prometheus-compatible backend
(for example [Grafana Mimir](https://grafana.com/oss/mimir/), [Cortex](https://cortexmetrics.io/), [Thanos](https://thanos.io/)).

This repository hosts:

- The plugin frontend — published to npm as
  [`@grafana/prometheus`](https://www.npmjs.com/package/@grafana/prometheus) and
  consumed by Grafana core until the plugin is removed from the monorepo.
- The plugin backend — the `promlib` Go library under
  [`pkg/promlib`](./pkg/promlib), consumed by Grafana core via a
  `go.mod` replace until the plugin is removed from the monorepo.
- The standalone plugin binary built from `pkg/main.go` and
  `pkg/datasource.go`, distributed through the Grafana plugin catalog.

## Requirements

- Grafana 12.3.0 or later (see `dependencies.grafanaDependency` in
  [`src/plugin.json`](./src/plugin.json)).

## Getting started

For Grafana versions where Prometheus is still bundled as a core data source,
no installation is required.

For detailed setup instructions, see the
[Prometheus data source documentation](https://grafana.com/docs/grafana/latest/datasources/prometheus/).

### Streaming Search API

The optional **Search API** data source setting uses Prometheus's streaming
metric and label discovery endpoints. It enables server-ranked fuzzy search in
the metric picker and code editor, and progressively renders results in the
Metrics explorer.

The target must be Prometheus v3.13 or later started with
`--enable-feature=search-api`, or Mimir started with
`-querier.experimental-search-api-enabled`. Grafana does not fall back to the
legacy discovery endpoints when this setting is enabled, so upstream errors are
shown to the user. Search streams remain subject to the data source response
limit; the bounded limits used by discovery consumers keep normal requests
within that limit.

## Issues

Please report bugs and feature requests at
[grafana/grafana-prometheus-datasource/issues](https://github.com/grafana/grafana-prometheus-datasource/issues/new).

## Contributing

Follow the
[Grafana plugin development guide](https://grafana.com/developers/plugin-tools/)
for local development. Run `mage -v` to build the backend and
`yarn dev` (or `yarn build`) for the frontend.

## License

This plugin is licensed under the [AGPL-3.0](LICENSE).
