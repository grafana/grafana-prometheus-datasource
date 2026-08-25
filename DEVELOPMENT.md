# Development

## Prerequisites

- Node.js (see `.nvmrc` for version)
- npm
- Go (for backend builds)
- Docker & Docker Compose (for e2e tests)

## Getting started

```bash
npm install
npm run build
```

## Project structure

| Path                           | Description                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| `src/`                         | Plugin frontend source (webpack-built, bundled into the Grafana plugin zip) |
| `packages/grafana-prometheus/` | `@grafana/prometheus` library (rollup-built, published to npm)              |
| `pkg/promlib/`                 | Go backend (`promlib`)                                                      |
| `.config/`                     | Grafana plugin tooling config — **do not modify**                           |

## Running locally

Build the plugin, then start Grafana with the default environment:

```bash
mage -v
npm run build
docker compose up -d
```

The default environment starts Grafana, Prometheus, and the gzip-forcing proxy
used by the e2e tests. Optional environments add one dataset without changing
the provisioned `prometheus-direct` and `prometheus-gzip` datasource UIDs:

| Command                           | Additional data                                                       |
| --------------------------------- | --------------------------------------------------------------------- |
| `npm run server:random-data`      | Random counters, gauges, and histograms                               |
| `npm run server:high-cardinality` | `fakedata_highcard_http_requests_total` with many label combinations  |
| `npm run server:utf8`             | UTF-8 metric and label names, including `a.utf8.metric 🤘`            |
| `npm run server:search-api`       | Prometheus 3.13.1 with the experimental Search API enabled            |
| `npm run server:full`             | All generators, node exporter, fake-data-gen, rules, and Alertmanager |

The scripts are shorthand for layering one override onto the base file:

```bash
docker compose -f docker-compose.yaml -f docker-compose.high-cardinality.yaml up --build
```

The full environment also enables Prometheus's remote-write receiver and
experimental PromQL functions. Alertmanager is available at
`http://localhost:9093`; the generators are intentionally only exposed to the
Compose network and are queried through Prometheus. Unlike Grafana's
host-oriented devenv, these environments do not enable Prometheus basic auth;
keeping the in-network endpoint unauthenticated preserves the shared direct and
gzip-proxy datasource provisioning.

The Search API environment additionally provisions `prometheus-search-api` as
the default datasource with `enableSearchApi` enabled. Use
`prometheus-direct` in the same environment to compare classic discovery
against the experimental metric and label search endpoints.

Stop the active environment before selecting another one:

```bash
docker compose down --remove-orphans
```

For an override environment, pass the same files to `down`, for example:

```bash
docker compose -f docker-compose.yaml -f docker-compose.utf8.yaml down --remove-orphans
```

For starting with a specific Grafana version

```bash
GRAFANA_VERSION=13.0.1 docker compose up
```

Grafana will be available at `http://localhost:3000`.

## Running locally against a local grafana/grafana checkout

If you want to develop against a local build of Grafana itself rather than the Docker image, follow these steps.

### 1. Set up the Grafana repository

Clone [grafana/grafana](https://github.com/grafana/grafana) somewhere in your workspace, for example next to this repository:

```
workspace/
  grafana/          ← grafana/grafana checkout
  plugins/
    grafana-prometheus-datasource/   ← this repo
```

### 2. Create a `custom.ini`

Grafana's [defaults.ini](https://github.com/grafana/grafana/blob/main/conf/defaults.ini#L25-L26) looks for additional plugins in `data/plugins`. It is cleaner to keep your plugin repos in a dedicated directory (e.g. `workspace/plugins`) and point Grafana there with a `custom.ini` file instead of touching `defaults.ini`.

Create `conf/custom.ini` next to `conf/defaults.ini` in the grafana/grafana repo and add at minimum:

```ini
app_mode = development
force_migration = true

[paths]
plugins = /your/workspace/plugins

[plugin.prometheus]
as_external = true

[log]
level = debug
```

### 3. Start Grafana

Start grafana/grafana with `npm ci && npm run start` for the frontend in one terminal and `make run` for the backend in another. Grafana will use
the plugin from `workspace/plugins/grafana-prometheus-datasource`, and you can iterate on frontend or backend changes directly.

### 4. Build the plugin

**Backend** — build the Go binary. There's no target for just your desktop
platform (only the exotic `LinuxS390X`/`WindowsARM64` targets exist
standalone), so this builds all of them:

```bash
mage
```

You must re-run this command after every backend change. After rebuilding, tell Grafana to reload the plugin:

```bash
mage reloadPlugin
```

**Frontend** — install dependencies and start the watch mode:

```bash
npm install
npm run dev
```

`npm run dev` starts an incremental build that picks up frontend changes automatically. This is powered by [`@grafana/create-plugin`](https://www.npmjs.com/package/@grafana/create-plugin), the base scaffolding tool used for Grafana plugins.

---

## Testing

```bash
npm run test:ci          # unit tests
npm run e2e              # playwright e2e tests (requires running Grafana)
npm run lint             # eslint
npm run typecheck        # typescript type checking
```

---

## Publishing `@grafana/prometheus` to npm

The `@grafana/prometheus` library is published from `packages/grafana-prometheus/` via a **manual** GitHub Actions workflow ([`release-npm.yml`](.github/workflows/release-npm.yml)). Publishing uses npm trusted publishing (OIDC) — no npm token secret is needed.

### Dry run

Validates the version check and build without publishing anything.

1. Go to the repo on GitHub → **Actions** → **Publish @grafana/prometheus to NPM**.
2. Click **Run workflow**.
3. Select the branch (typically `main`).
4. Check the **Dry run** checkbox.
5. Click **Run workflow**.

The workflow will build the library and print a summary of what _would_ be published (version and npm dist-tag) without actually publishing.

### Publishing a release

1. **Create a release branch** from `main`, named like `release-grafana-prometheus-<version>`, and open a PR.

2. **Apply pending changesets** on that branch by running `npm run changeset:version` and selecting `@grafana/prometheus` (or pass `--npm-package`). This consumes the pending `@grafana/prometheus` changesets, bumps the version in `packages/grafana-prometheus/package.json`, and updates its `CHANGELOG.md`. The corresponding datasource changesets remain pending for the next datasource release.

   > **Note:** Changesets are added in feature PRs via `npm run changeset`. Selecting `@grafana/prometheus` intentionally creates two files with the same summary: the package changeset and a datasource mirror changeset using the same bump type. Commit both files; without pending package changesets there is nothing to include in the package changelog.

   > **Note:** If a PR intentionally needs no changelog entry, add the `no-changelog` label to it so the changeset CI check passes.

3. **Verify the bumped version** in `packages/grafana-prometheus/package.json` — no manual bump is needed when `changeset:version` succeeds.
   The npm dist-tag is derived automatically from the version string:

   | Version        | npm tag  |
   | -------------- | -------- |
   | `1.2.0`        | `latest` |
   | `1.2.0-dev.1`  | `dev`    |
   | `1.0.0-beta.3` | `beta`   |

4. **Merge the release PR** to `main`.

5. **Run the publish workflow**: go to the repo on GitHub → **Actions** → **Publish @grafana/prometheus to NPM** → **Run workflow** → select `main` → leave **Dry run** unchecked → **Run workflow**.

The workflow will fail with a clear error if the local version is not newer than what's already on npm.

### Verifying a publish

```bash
npm view @grafana/prometheus versions --json
npm view @grafana/prometheus dist-tags
```

### Troubleshooting

| Problem                               | Solution                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Local version is not newer than npm" | Bump the version in `packages/grafana-prometheus/package.json` first                                      |
| OIDC / provenance errors              | Ensure the `npm-publish` GitHub environment exists and npm trusted publishing is configured for this repo |
| Build fails                           | Run `cd packages/grafana-prometheus && npm ci && npm run build` locally to reproduce                      |
