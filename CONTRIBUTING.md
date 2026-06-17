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

## Changelog or Changeset

Each PR must have a proper changeset that explains the PR's purpose in one line. That information will be used to generate a changelog when we release a new version of the respective package.

To have a changeset, simply run `yarn changeset` and follow the CLI instructions.
When you are done commit the auto-generated changeset file to your PR.  

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
- Run `yarn changeset` and commit the generated file — this replaces manual `CHANGELOG.md` edits.
- Ensure `yarn lint`, `yarn typecheck`, and `yarn test:ci` all pass locally before opening a PR.

## Release Process

> Releases require repository commit access. The steps below are for maintainers.

This repository has three different release processes.

- grafana prometheus plugin release which will be released to plugin catalog.
- grafana prometheus frontend package which is being released to NPM.
- grafana prometheus backend library a.k.a `promlib` will be released via tagging. 

Each will be explained below:

_**NOTE: if there is no changeset for the package you want to release, CLI will still bump the version and create a changelog to help you.**_

### Grafana Plugin Release `grafana-prometheus-datasource`

- Create a new branch from latest `main`.
- Run `yarn changeset:version --datasource` (or run `yarn changeset:version` and select `grafana-prometheus-datasource`)
- Follow the CLI instructions. 
  - Changesets will be aggregated and a new changelog entry will be generated.
  - Aggregated changesets will be deleted.
  - The version will be bumped in root level `package.json` and `packages/grafana-prometheus-datasource/package.json`.
  - Commit everything.
- After merging the PR visit [Plugins - CD](https://github.com/grafana/grafana-prometheus-datasource/actions/workflows/publish.yaml) in actions.
- Run workflow by selecting Branch: `main`, Environment: `prod`, Scope: `cloud (recommended)`
- An automated workflow will pick your new version and roll it out to cloud.  

### NPM Library Release `@grafana/prometheus`

The library in `packages/grafana-prometheus/` is released independently via a manual GitHub Actions workflow.

- Create a new branch from latest `main`.
- Run `yarn changeset:version` and select `@grafana/prometheus`
- Follow the CLI instructions.
  - Changesets will be aggregated and a new changelog entry will be generated.
  - Aggregated changesets will be deleted.
  - The version will be bumped in `packages/grafana-prometheus/package.json`.
  - Commit everything.
- After merging the PR visit [Publish @grafana/prometheus to NPM](https://github.com/grafana/grafana-prometheus-datasource/actions/workflows/release-npm.yml) in actions.
- Run the workflow by selecting Branch: `main`.
- Approve the pending workflow run in the Actions UI when it pauses for approval.

To verify a publish:

```bash
npm view @grafana/prometheus versions --json
npm view @grafana/prometheus dist-tags
```

### Grafana Prometheus Backend Library Release `promlib`

The backend library in `pkg/promlib` is released (tagged) independently via a git tag.

- Create a new branch from latest `main`.
- Run `yarn changeset:version` and select `promlib`
- Follow the CLI instructions.
  - Changesets will be aggregated and a new changelog entry will be generated.
  - Aggregated changesets will be deleted.
  - The version will be bumped in `packages/promlib`.
  - Commit everything.
- After merging the PR checkout the commit you just merged. `git checkout <COMMIT_SHA>`
- Run `git tag pkg/promlib/<VERSION>` (For example `git tag pkg/promlib/v0.0.12`)
  - NOTE: We're using Lightweight Tags, so no other options are required
- Run `git push origin pkg/promlib/<VERSION>`
- Verify that the tag was created successfully [here](https://github.com/grafana/grafana-prometheus-datasource/tags)
- **DO NOT RELEASE** anything! Tagging is enough.
- After tagging, wait 5-10 minutes for the Go module registry to pick up the new tag.
- Bump `github.com/grafana/grafana-prometheus-datasource/pkg/promlib` to the new version in your project's `go.mod`.
