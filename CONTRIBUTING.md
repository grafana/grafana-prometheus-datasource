# Contributing to Prometheus Data Source for Grafana

Thank you for your interest in contributing! This guide covers how to participate in this open-source project.

Contributors are expected to adhere to the [Grafana Code of Conduct](https://github.com/grafana/grafana/blob/main/CODE_OF_CONDUCT.md).

You can browse [existing issues](https://github.com/grafana/grafana-prometheus-datasource/issues) or open a new one before submitting a pull request — especially for larger changes, it's worth discussing the approach first.

## Required Tools

| Tool | Notes |
| --- | --- |
| [Git](https://git-scm.com/) | Version control |
| [Go](https://go.dev/) | See `go.mod` for minimum version |
| [Mage](https://magefile.org/) | Backend build tool |
| [Node.js](https://nodejs.org/) | `>=22`; see `.nvmrc` for the pinned version |
| [yarn](https://yarnpkg.com/) | JavaScript package manager |
| [Docker](https://www.docker.com/) | Required for local Grafana and e2e tests |

## Frontend Development

Install dependencies:

```bash
yarn install
```

Build the plugin frontend (one-shot):

```bash
yarn build
```

Watch mode (rebuilds on file change):

```bash
yarn dev
```

Run frontend unit tests:

```bash
yarn test        # interactive watch mode
yarn test:ci     # single-run, used in CI
```

Type-checking:

```bash
yarn typecheck
```

Lint:

```bash
yarn lint
yarn lint:fix
```

## Backend Development

Build the backend binary with Mage:

```bash
mage build:linux   # or build:darwin / build:windows
```

## Running Locally

Start a local Grafana instance with the plugin pre-loaded:

```bash
docker compose up -d
```

For starting with a specific Grafana version

```bash
GRAFANA_VERSION=13.0.1 docker compose up
```

Grafana will be available at `http://localhost:3000` (default credentials: `admin` / `admin`).

## End-to-End Tests

E2E tests use [Playwright](https://playwright.dev/) via `@grafana/plugin-e2e`. Start the server first, then run the tests:

```bash
yarn server   # starts Grafana via Docker
yarn e2e
```

## Project Structure

| Path | Description |
| --- | --- |
| `src/` | Plugin frontend source (webpack-built, bundled into the Grafana plugin zip) |
| `packages/grafana-prometheus/` | `@grafana/prometheus` library (rollup-built, published to npm separately) |
| `pkg/promlib/` | Go backend library (`promlib`) |
| `provisioning/` | Grafana provisioning config used by the local Docker setup |
| `playwright/` | E2E test fixtures and helpers |
| `.config/` | Grafana plugin tooling config — **do not modify** (managed by `@grafana/plugin-tools`) |

## Pull Requests

- Keep PRs focused — one logical change per PR.
- Add or update tests for any changed behaviour.
- Update `CHANGELOG.md` under the `Unreleased` heading describing what changed.
- Ensure `yarn lint`, `yarn typecheck`, and `yarn test:ci` all pass locally before opening a PR.

## Release Process

> Releases require repository commit access. The steps below are for maintainers.

### Grafana Plugin Release

1. Update the version in `package.json`.
2. Document the changes under a new version heading in `CHANGELOG.md`.
3. Open a pull request, get it reviewed and merged to `main`.
4. Follow the [Grafana plugin release process](https://grafana.com/developers/plugin-tools/publish-a-plugin/publish-or-update-a-plugin.md) to package and publish the plugin.

### `@grafana/prometheus` npm Library Release

The library in `packages/grafana-prometheus/` is released independently via a manual GitHub Actions workflow.

1. Bump the version in `packages/grafana-prometheus/package.json` and merge to `main`.
   The npm dist-tag is derived automatically:

   | Version | npm tag |
   | --- | --- |
   | `1.2.0` | `latest` |
   | `1.2.0-dev.1` | `dev` |
   | `1.0.0-beta.3` | `beta` |

2. Go to **Actions → Publish @grafana/prometheus to NPM** on GitHub.
3. Click **Run workflow** → select `main` → leave **Dry run** unchecked → **Run workflow**.

To verify a publish:

```bash
npm view @grafana/prometheus versions --json
npm view @grafana/prometheus dist-tags
```
