# promlib

Prometheus Library (a.k.a. promlib) is the foundation of the Grafana Prometheus data source backend.

### Datasource lifecycle

Each `Service` owns the clients for one datasource. Create it with
`NewDatasourceService(ctx, settings, httpClientProvider, logger, extendOptions)`.
The datasource settings and construction-time Grafana configuration must be supplied
when creating the service; settings in later requests do not select or replace its clients.

The former shared-manager `NewService` constructor has been removed. Callers that
serve multiple datasources must manage their instances in the host, for example with
the plugin SDK's `datasource.Manage` or `datasource.NewInstanceManager`.

Return the service from the SDK instance factory, or forward `Dispose` from the
wrapper returned by that factory. The SDK then owns caching, invalidation, and disposal.
Do not defer disposal inside an SDK factory: the returned service must remain usable.

A host that creates a service for just one request should defer `service.Dispose()`
after successful construction. Disposal closes idle HTTP connections.

### How to tag/version?

- Checkout the commit you want to tag (`git checkout <COMMIT_SHA>`)
- Run `git tag pkg/promlib/<VERSION>` (For example `git tag pkg/promlib/v0.0.12`)
  - NOTE: We're using Lightweight Tags, so no other options are required
- Run `git push origin pkg/promlib/<VERSION>`
- Verify that the tag was created successfully [here](https://github.com/grafana/grafana-prometheus-datasource/tags)
- DO NOT RELEASE anything! Tagging is enough.
- After tagging and waiting 5-10 minutes for go module registry to catch up just bump the `promlib` version on `grafana/grafana`
