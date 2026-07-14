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

Start Grafana with the plugin:

```bash
docker compose up -d
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

Start grafana/grafana with `yarn install && yarn start` for the frontend in one terminal and `make run` for the backend in another. Grafana will use the plugin from `workspace/plugins/grafana-prometheus-datasource`, and you can iterate on frontend or backend changes directly.

### 4. Build the plugin

**Backend** — build the Go binary for your platform. On Apple Silicon:

```bash
mage build:darwinARM64
```

Run `mage -v` with no target to build for all supported platforms. You must re-run this command after every backend change. After rebuilding, tell Grafana to reload the plugin:

```bash
mage reloadPlugin
```

**Frontend** — install dependencies and start the watch mode:

```bash
yarn install
yarn dev
```

`yarn dev` starts an incremental build that picks up frontend changes automatically. This is powered by [`@grafana/create-plugin`](https://www.npmjs.com/package/@grafana/create-plugin), the base scaffolding tool used for Grafana plugins.

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

2. **Apply pending changesets** on that branch by running `yarn changeset:version` and selecting `@grafana/prometheus` (or pass `--library`). This consumes the pending changesets, bumps the version in `packages/grafana-prometheus/package.json`, and updates its `CHANGELOG.md`.

   > **Note:** Changesets are added in feature PRs via `yarn changeset`. Make sure every feature PR that should appear in the release includes one — without pending changesets there is nothing to version.

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
