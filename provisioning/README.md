# Local provisioning

The default Compose environment provisions two datasources:

- `prometheus-direct` queries the `prometheus` service directly.
- `prometheus-gzip` queries the same service through the deterministic
  gzip-forcing proxy used by the e2e tests.

Both datasource UIDs remain available in every optional devenv. Compose
overrides replace the Prometheus scrape configuration, not Grafana
provisioning:

- `prometheus.random-data.yml` scrapes the random-data generator.
- `prometheus.high-cardinality.yml` scrapes the high-cardinality generator.
- `prometheus.utf8.yml` scrapes the UTF-8 generator.
- `prometheus.full.yml` enables every generator, node exporter,
  fake-data-gen, recording and alert rules, and Alertmanager.

The Search API Compose override keeps the default scrape configuration and
mounts an extra datasource file onto
`/etc/grafana/provisioning/datasources/search-api.yml`. That layers
`prometheus-search-api` on top of the base provisioning mount, so the two
standard UIDs stay defined in `provisioning/datasources/datasources.yml`.
Normal and e2e runs are unaffected because they do not use this override.

The default `prometheus.yml` intentionally contains only Prometheus and
Grafana targets so e2e runs do not show inactive optional targets as `DOWN`.

For more information, see
[Provision dashboards and data sources](https://grafana.com/tutorials/provision-dashboards-and-data-sources/).
