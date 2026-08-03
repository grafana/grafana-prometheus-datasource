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

The default `prometheus.yml` intentionally contains only Prometheus and
Grafana targets so e2e runs do not show inactive optional targets as `DOWN`.

For more information, see
[Provision dashboards and data sources](https://grafana.com/tutorials/provision-dashboards-and-data-sources/).
