# Contributing to Prometheus Data Source for Grafana

## Signed commits are required

> [!IMPORTANT]
> All commits must be [signed](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits) (GPG, SSH, or S/MIME)
to be merged into this repository. Pull requests with unsigned commits will need to be re-committed with signatures before they can be merged.

## Never bump versions manually

> [!CAUTION]
> **Do not change any package version by hand. Ever.**
>
> In a normal pull request (feature, bug fix, refactor, docs, dependency update):
>
> - ❌ **Don't** edit the `version` field in any `package.json`.
> - ❌ **Don't** edit any `CHANGELOG.md`.
> - ❌ **Don't** run `npm run changeset:version`.
> - ✅ **Do** run `npm run changeset` and commit the generated `.changeset/*.md` files.
>
> Version bumps happen **only** in dedicated release PRs, and **only** through
> `npm run changeset:version`. PRs that bump versions manually will be asked to revert
> those changes.

This repository ships three packages. Each one is versioned in **its own separate release PR**,
and each needs a different step after that PR is merged:

| Order | Package                                                | What it is                          | Release PR command                           | After the PR is merged                                                                                             |
|-------|--------------------------------------------------------|-------------------------------------|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| 1     | [`promlib`](#release-promlib)                          | Go backend library in `pkg/promlib` | `npm run changeset:version -- --promlib`     | **Push a git tag** `pkg/promlib/vX.Y.Z`. Details: [Release promlib](#release-promlib)                              |
| 2     | [`@grafana/prometheus`](#release-grafana-prometheus)   | Frontend library published to npm   | `npm run changeset:version -- --npm-package` | **Run the npm release workflow**. Details: [Release Grafana Prometheus NPM Package](#release-grafana-prometheus)   |
| 3     | [`grafana-prometheus-datasource`](#release-datasource) | The plugin itself                   | `npm run changeset:version -- --datasource`  | **Run the plugin catalog publish workflow**. Details: [Release Grafana Prometheus Datasource](#release-datasource) |

Rules for release PRs:

1. **One package per PR.** Never version two packages in the same PR.
2. **Follow the order above** when releasing more than one package: `promlib` first, then
   `@grafana/prometheus`, then `grafana-prometheus-datasource`. Releasing a library leaves a
   mirrored changeset for the datasource, so the datasource release goes last and picks up
   all of them in its changelog.
3. **Always use `npm run changeset:version`.** It updates the version, writes the changelog
   and deletes the used changesets in one go. Doing any of that by hand breaks the process.
4. **Don't skip the post-merge step.** Merging the release PR does not publish anything on its
   own. See [Release Process](#release-process) for the exact steps for each package.

Thank you for your interest in contributing! This guide covers how to participate in this open-source project.

Contributors are expected to adhere to the [Grafana Code of Conduct](https://github.com/grafana/grafana/blob/main/CODE_OF_CONDUCT.md).

You can browse [existing issues](https://github.com/grafana/grafana-prometheus-datasource/issues) or open a new one before submitting a pull request —
especially for larger changes, it's worth discussing the approach first.

## Required Tools

| Tool                              | Notes                                       |
|-----------------------------------|---------------------------------------------|
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

Run backend tests:

```bash
mage test          # go test ./pkg/... plus the pkg/promlib module
```

## Data Source Configuration Schema

`pkg/schema/dsconfig.json` is the **single source of truth** for the data source's
configuration surface — every field a user can set, where it is stored (`root`,
`jsonData`, `secureJsonData`), its type, validation rules and UI hints. It is consumed by
provisioning tooling, documentation and automation.

The schema format is defined and documented by [`grafana/dsconfig`](https://github.com/grafana/dsconfig/tree/main/dsconfig):

- [README](https://github.com/grafana/dsconfig/tree/main/dsconfig#readme) — concepts and a worked example for each field shape (root / jsonData /
  secret / array / virtual), plus current gaps and limitations.
- [`schema.md`](https://github.com/grafana/dsconfig/blob/main/dsconfig/schema.md) — full property reference.
- [`schema.json`](https://github.com/grafana/dsconfig/blob/main/dsconfig/schema.json) — the JSON Schema `dsconfig.json` validates against. It is
  pinned via the `$schema` key at the top of our file, so editors autocomplete from it; bump that URL when you bump
  `github.com/grafana/dsconfig/schema` in `go.mod`.

The rest of this section covers only what is specific to this repository.

### Layout

| File in `pkg/schema/` | Description                                                                                                                       |
|-----------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `dsconfig.json`       | Source of truth — **edit this**                                                                                                   |
| `dsconfig_test.go`    | Wires the schema into the shared conformance suite; also holds `SecureKeys` and the provisioning examples shipped with the plugin |
| `*.gen.json`          | Generated artifacts — **never hand-edit**; `npm run build` copies them into `dist/schema/` via `webpack.config.ts`                |

### Adding a new settings option

1. **Declare the field** in `pkg/schema/dsconfig.json` under `fields`, and add its `id` to
   the appropriate `groups[].fieldRefs` entry. Field ids follow the `<target>_<key>`
   convention, e.g. `jsonData_httpMethod`.
2. **Add the matching Go field** to `PromOptions` in `pkg/promlib/models/settings.go` with
   a json tag equal to the schema `key`. This parity is enforced in both directions — a
   field in the schema but not the struct (or vice versa) fails the test suite. Secrets (`target: secureJsonData`) are the exception: they get no
   struct field, but their key
   must be added to `SecureKeys` in `pkg/schema/dsconfig_test.go`.
3. **Regenerate the artifacts** and commit them with your change:

   ```bash
   go generate ./pkg/schema/...
   ```

4. **Verify**:

   ```bash
   go test ./pkg/schema/...
   ```

If you add a setting that changes what a typical configuration looks like, update
`SettingsExamples` in `pkg/schema/dsconfig_test.go` too — those are the provisioning
payloads shipped with the plugin. Use placeholders like `REPLACE_WITH_PASSWORD`, never
real credentials.

### When the conformance suite fails

Most failures are self-explanatory from the assertion message. The three you are most
likely to hit:

- `SchemaArtifactInSync` — a `.gen.json` file has drifted. Run `go generate ./pkg/schema/...` and commit the result.
- `JSONDataMatchesStruct` / `JSONDataTypesMatchStruct` — the schema and `PromOptions` disagree on keys or types. Update whichever side is behind.
- `SecureValuesMatchLoadSettings` — the schema's `secureJsonData` fields and `SecureKeys` disagree.

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

Each PR must have a proper changeset that explains the PR's purpose in one line. That information will be used to generate a changelog when we release
a new version of the respective package.

To have a changeset, simply run `npm run changeset` and follow the CLI instructions.
When targeting `@grafana/prometheus` or `promlib`, the command intentionally
creates two changeset files: one for the selected library and a mirrored
datasource changeset with the same summary — matching the library's bump type
for `@grafana/prometheus`, always patch for `promlib`. Both libraries are
shipped as part of the datasource, so commit both generated files. A direct
datasource changeset still creates only one file.

## Project Structure

| Path                           | Description                                                                            |
|--------------------------------|----------------------------------------------------------------------------------------|
| `src/`                         | Plugin frontend source (webpack-built, bundled into the Grafana plugin zip)            |
| `packages/grafana-prometheus/` | `@grafana/prometheus` library (rollup-built, published to npm separately)              |
| `pkg/promlib/`                 | Go backend library (`promlib`)                                                         |
| `pkg/schema/`                  | `dsconfig` configuration schema — single source of truth for data source settings      |
| `provisioning/`                | Grafana provisioning config used by the local Docker setup                             |
| `playwright/`                  | E2E test fixtures and helpers                                                          |
| `.config/`                     | Grafana plugin tooling config — **do not modify** (managed by `@grafana/plugin-tools`) |

## Pull Requests

- Keep PRs focused — one logical change per PR.
- Add or update tests for any changed behaviour.
- Run `npm run changeset` and commit all generated files — this replaces manual `CHANGELOG.md` edits.
- **Don't bump any version or edit any `CHANGELOG.md`.** See [Never bump versions manually](#never-bump-versions-manually).
- Ensure `npm run lint`, `npm run typecheck`, and `npm run test:ci` all pass locally before opening a PR.
- If you touched data source settings, run `go generate ./pkg/schema/...` and commit the regenerated `.gen.json` artifacts.

## Release Process

> Releases require repository commit access. The steps below are for maintainers.

> [!IMPORTANT]
> **Read this before you start a release.**
>
> - Each package gets **its own release PR**. Never version two packages in one PR.
> - Release in this order: **1. `promlib` → 2. `@grafana/prometheus` → 3. `grafana-prometheus-datasource`**.
    > Skip any package that has nothing to release, but keep the order for the rest.
> - Always bump versions with **`npm run changeset:version`**. Never edit versions or changelogs by hand.
> - **Merging the PR is not the end.** Every package has a required step after merge:
>   - `promlib` → **push a git tag**
    >   - `@grafana/prometheus` → **run the npm release workflow**
    >   - `grafana-prometheus-datasource` → **run the plugin catalog publish workflow**

_**NOTE: if there is no changeset for the package you want to release, CLI will still bump the version and create a changelog to help you.**_

<a id="release-promlib"></a>

### 1. Backend library `promlib` (release by git tag)

The backend library in `pkg/promlib` is released (tagged) independently via a git tag.

**Step A: open the release PR**

1. Create a new branch from latest `main`.
2. Run `npm run changeset:version -- --promlib` (or run `npm run changeset:version` and select `promlib`).
3. Follow the CLI instructions. The CLI will:
    - aggregate the changesets and generate a new changelog entry,
    - delete the aggregated changesets,
    - keep the mirrored datasource changesets pending for the datasource release,
    - bump the version in `packages/promlib`.
4. Commit everything, open the PR, and get it merged.

**Step B: after the PR is merged, push a tag (required)**

1. Check out the commit you just merged: `git checkout <COMMIT_SHA>`
2. Create the tag: `git tag pkg/promlib/<VERSION>` (for example `git tag pkg/promlib/v0.0.12`).
    - We use lightweight tags, so no other options are needed.
3. Push the tag: `git push origin pkg/promlib/<VERSION>`
4. Verify the tag exists [here](https://github.com/grafana/grafana-prometheus-datasource/tags).
5. **DO NOT RELEASE** anything! Tagging is enough.
6. Wait 5-10 minutes for the Go module registry to pick up the new tag.
7. Bump `github.com/grafana/grafana-prometheus-datasource/pkg/promlib` to the new version in your project's `go.mod`.

<a id="release-grafana-prometheus"></a>

### 2. NPM library `@grafana/prometheus` (release to npm)

The library in `packages/grafana-prometheus/` is released independently via a manual GitHub Actions workflow.

**Step A: open the release PR**

1. Create a new branch from latest `main`.
2. Run `npm run changeset:version -- --npm-package` (or run `npm run changeset:version` and select `@grafana/prometheus`).
3. Follow the CLI instructions. The CLI will:
    - aggregate the changesets and generate a new changelog entry,
    - delete the aggregated changesets,
    - keep the mirrored datasource changesets pending for the datasource release,
    - bump the version in `packages/grafana-prometheus/package.json`.
4. Commit everything, open the PR, and get it merged.

**Step B: after the PR is merged, publish to npm (required)**

1. Open [Publish @grafana/prometheus to NPM](https://github.com/grafana/grafana-prometheus-datasource/actions/workflows/release-npm.yml) in Actions.
2. Run the workflow with Branch: `main`.
3. Approve the pending workflow run in the Actions UI when it pauses for approval.
4. Verify the publish:

   ```bash
   npm view @grafana/prometheus versions --json
   npm view @grafana/prometheus dist-tags
   ```

<a id="release-datasource"></a>

### 3. Grafana plugin `grafana-prometheus-datasource` (publish to the plugin catalog)

Release this last, so its changelog includes the mirrored changesets from the library releases above.

**Step A: open the release PR**

1. Create a new branch from latest `main`.
2. Run `npm run changeset:version -- --datasource` (or run `npm run changeset:version` and select `grafana-prometheus-datasource`).
3. Follow the CLI instructions. The CLI will:
    - aggregate the changesets and generate a new changelog entry,
    - delete the aggregated changesets,
    - bump the version in the root `package.json` and `packages/grafana-prometheus-datasource/package.json`.
4. Commit everything, open the PR, and get it merged.

**Step B: after the PR is merged, publish to the plugin catalog (required)**

1. Open [Plugins - CD](https://github.com/grafana/grafana-prometheus-datasource/actions/workflows/publish.yaml) in Actions.
2. Run the workflow with Branch: `main`, Environment: `prod`, Scope: `cloud (recommended)`.
3. An automated workflow picks up the new version and rolls it out to Grafana Cloud.
