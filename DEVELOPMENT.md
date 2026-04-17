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

| Path | Description |
|---|---|
| `src/` | Plugin frontend source (webpack-built, bundled into the Grafana plugin zip) |
| `packages/grafana-prometheus/` | `@grafana/prometheus` library (rollup-built, published to npm) |
| `pkg/promlib/` | Go backend (`promlib`) |
| `.config/` | Grafana plugin tooling config — **do not modify** |

## Running locally

Start Grafana with the plugin:

```bash
docker compose up -d
```

Grafana will be available at `http://localhost:3000`.

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

The workflow will build the library and print a summary of what *would* be published (version and npm dist-tag) without actually publishing.

### Publishing a release

1. **Bump the version** in `packages/grafana-prometheus/package.json` and merge to `main`.
   The npm dist-tag is derived automatically from the version string:

   | Version | npm tag |
   |---|---|
   | `1.2.0` | `latest` |
   | `1.2.0-dev.1` | `dev` |
   | `1.0.0-beta.3` | `beta` |

2. Go to the repo on GitHub → **Actions** → **Publish @grafana/prometheus to NPM**.
3. Click **Run workflow** → select `main` → leave **Dry run** unchecked → **Run workflow**.

The workflow will fail with a clear error if the local version is not newer than what's already on npm.

### Verifying a publish

```bash
npm view @grafana/prometheus versions --json
npm view @grafana/prometheus dist-tags
```

### Troubleshooting

| Problem | Solution |
|---|---|
| "Local version is not newer than npm" | Bump the version in `packages/grafana-prometheus/package.json` first |
| OIDC / provenance errors | Ensure the `npm-publish` GitHub environment exists and npm trusted publishing is configured for this repo |
| Build fails | Run `cd packages/grafana-prometheus && npm ci && npm run build` locally to reproduce |
