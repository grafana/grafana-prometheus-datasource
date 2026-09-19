# Contributing to Prometheus Data Source for Grafana

## Signed commits are required

> [!IMPORTANT]
> All commits must be [signed](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits) (GPG, SSH, or S/MIME) to be merged into this repository. Pull requests with unsigned commits will need to be re-committed with signatures before they can be merged.

Thank you for your interest in contributing! This guide covers how to participate in this open-source project.

Contributors are expected to adhere to the [Grafana Code of Conduct](https://github.com/grafana/grafana/blob/main/CODE_OF_CONDUCT.md).

You can browse [existing issues](https://github.com/grafana/grafana-prometheus-datasource/issues) or open a new one before submitting a pull request — especially for larger changes, it's worth discussing the approach first.

## Required Tools

| Tool                              | Notes                                       |
| --------------------------------- | ------------------------------------------- |
| [Git](https://git-scm.com/)       | Version control                             |
| [Go](https://go.dev/)             | See `go.mod` for minimum version            |
| [Mage](https://magefile.org/)     | Backend build tool                          |
| [Node.js](https://nodejs.org/)    | `>=24`; see `.nvmrc` for the pinned version |
| [npm](https://www.npmjs.com/)     | JavaScript package manager                  |
| [Docker](https://www.docker.com/) | Required for local Grafana and e2e tests    |

### Package manager version

This repository defines the required package manager and its exact version in the
`packageManager` field of `package.json`. You don't have to use it, but enabling
[Corepack](https://github.com/nodejs/corepack) is a convenient way to make your
terminal automatically use that version instead of whatever `npm` you have
installed globally:

Corepack is included with many Node.js distributions. Check whether it is
available:

```bash
corepack --version
```

If the command is unavailable, install the standalone Corepack package:

```bash
npm install --global --ignore-scripts corepack
```

Then enable its npm shim:

```bash
corepack enable npm
```

Restart your terminal after enabling Corepack. No directory-change hook is
required: once enabled, Corepack reads the nearest `package.json` whenever you
run `npm`, in any directory. You can verify the selected version from the
repository directory:

```bash
npm --version
```

Corepack manages the package manager version only; it does not install or select
the Node.js version specified by the `engines` field.

## Frontend Development

Install dependencies:

```bash
npm install
```

Build the plugin frontend (one-shot):

```bash
npm run build
```

Watch mode (rebuilds on file change):

```bash
npm run dev
```

Run frontend unit tests:

```bash
npm test         # interactive watch mode
npm run test:ci  # single-run, used in CI
```

Type-checking:

```bash
npm run typecheck
```

Lint:

```bash
npm run lint
npm run lint:fix
```

## Backend Development

Build the backend binary with Mage. There's no target for just your desktop
platform (only the exotic `LinuxS390X`/`WindowsARM64` targets exist
standalone), so this builds all of them:

```bash
mage
```

## Running Locally

Start a local Grafana instance with the plugin pre-loaded:

```bash
docker compose up -d
```

The default Compose stack is also the e2e stack. For manual testing with
specialized Prometheus data, use one of:

```bash
npm run server:random-data
npm run server:high-cardinality
npm run server:utf8
npm run server:search-api
npm run server:full
```

See [DEVELOPMENT.md](./DEVELOPMENT.md#running-locally) for the services,
representative metrics, and shutdown commands for each environment.

For starting with a specific Grafana version

```bash
GRAFANA_VERSION=13.0.1 docker compose up
```

Grafana will be available at `http://localhost:3000` (default credentials: `admin` / `admin`).

## End-to-End Tests

E2E tests use [Playwright](https://playwright.dev/) via `@grafana/plugin-e2e`. Start the server first, then run the tests:

```bash
npm run server   # starts Grafana via Docker
npm run e2e
```

## Changelog or Changeset

Each PR must have a proper changeset that explains the PR's purpose in one line. That information will be used to generate a changelog when we release a new version of the respective package.

To have a changeset, simply run `npm run changeset` and follow the CLI instructions.
When targeting `@grafana/prometheus` or `promlib`, the command intentionally
creates two changeset files: one for the selected library and a mirrored
datasource changeset with the same summary — matching the library's bump type
for `@grafana/prometheus`, always patch for `promlib`. Both libraries are
shipped as part of the datasource, so commit both generated files. A direct
datasource changeset still creates only one file.

## Project Structure

| Path                           | Description                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `src/`                         | Plugin frontend source (webpack-built, bundled into the Grafana plugin zip)            |
| `packages/grafana-prometheus/` | `@grafana/prometheus` library (rollup-built, published to npm separately)              |
| `pkg/promlib/`                 | Go backend library (`promlib`)                                                         |
| `provisioning/`                | Grafana provisioning config used by the local Docker setup                             |
| `playwright/`                  | E2E test fixtures and helpers                                                          |
| `.config/`                     | Grafana plugin tooling config — **do not modify** (managed by `@grafana/plugin-tools`) |

## Pull Requests

- Keep PRs focused — one logical change per PR.
- Add or update tests for any changed behaviour.
- Run `npm run changeset` and commit all generated files — this replaces manual `CHANGELOG.md` edits.
- Ensure `npm run lint`, `npm run typecheck`, and `npm run test:ci` all pass locally before opening a PR.

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
- Run `npm run changeset:version -- --datasource` (or run `npm run changeset:version` and select `grafana-prometheus-datasource`)
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
- Run `npm run changeset:version` and select `@grafana/prometheus`
- Follow the CLI instructions.
  - Changesets will be aggregated and a new changelog entry will be generated.
  - Aggregated changesets will be deleted.
  - Mirrored datasource changesets will remain pending for the next datasource release.
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
- Run `npm run changeset:version` and select `promlib`
- Follow the CLI instructions.
  - Changesets will be aggregated and a new changelog entry will be generated.
  - Aggregated changesets will be deleted.
  - Mirrored datasource changesets will remain pending for the next datasource release.
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
