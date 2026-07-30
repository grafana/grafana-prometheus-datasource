# scripts

Changesets tooling for this repo. We use `@changesets/cli`, but wrap it so that
each release targets exactly **one** package and so that "stub" workspace
packages can stand in for things changesets cannot version directly (the
workspace root and the `pkg/promlib` Go module).

## Packages

| Name                            | Path                                            | What gets versioned                                                                                                                          |
| ------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `grafana-prometheus-datasource` | `packages/grafana-prometheus-datasource` (stub) | The plugin/workspace root — version + `CHANGELOG.md` mirrored to repo root.                                                                  |
| `@grafana/prometheus`           | `packages/grafana-prometheus`                   | The published npm package, versioned in place.                                                                                               |
| `promlib`                       | `packages/promlib` (stub)                       | The `pkg/promlib` Go module — `CHANGELOG.md` mirrored to `pkg/promlib/`. The Go module itself is released via `pkg/promlib/vX.Y.Z` git tags. |

Stub packages are private, contain no source, and exist only because
`@changesets/cli` can only target packages it finds via the `packages/*`
workspace glob.

## Scripts

### `add-changeset.js` — `npm run changeset`

Creates one `.changeset/<id>.md` for one package.

```bash
npm run changeset                                            # fully interactive
npm run changeset -- --datasource     --patch "Fix panel"
npm run changeset -- --npm-package    --minor "Add util"
npm run changeset -- --npm-package    --major "Breaking change"
npm run changeset -- --promlib        --patch "Fix promlib bug"
```

Flags: `--datasource`, `--npm-package`,
`--promlib`, plus `--patch` / `--minor` / `--major`. Anything left over is the
summary. Missing inputs are prompted for; an empty package selection is an
error (no default).

### `version-changeset.js` — `npm run changeset:version`

Versions exactly one package. `changeset version` always consumes every
pending changeset for every referenced package, so this script:

1. Picks a target (`--datasource` / `--npm-package` / `--promlib`, or interactive).
2. Moves changesets that don't reference that package into `.changeset-hold/`.
3. Runs `changeset version`.
4. Restores the held changesets so they remain pending for next time.
5. For stub packages, calls `sync-changelog.js` to mirror the result to the
   real location.

```bash
npm run changeset:version                          # interactive
npm run changeset:version -- --datasource          # plugin/root only
npm run changeset:version -- --npm-package         # @grafana/prometheus only
npm run changeset:version -- --promlib             # pkg/promlib only
```

If no pending changeset references the chosen package, the script is a no-op
and exits cleanly. Held changesets are restored even if `changeset version`
fails.

### `sync-changelog.js`

Mirrors a stub package's `CHANGELOG.md` (and, where relevant, its
`package.json` version) to the real location it represents:

| Stub                                     | Mirrored to                | Version mirrored?                          |
| ---------------------------------------- | -------------------------- | ------------------------------------------ |
| `packages/grafana-prometheus-datasource` | repo root                  | yes                                        |
| `packages/promlib`                       | `pkg/promlib/CHANGELOG.md` | no (Go module — version lives in git tags) |

Called automatically from `version-changeset.js` after a successful
`changeset version`. Can also be invoked directly:

```bash
node scripts/sync-changelog.js                 # default: datasource → root
node scripts/sync-changelog.js promlib         # promlib stub → pkg/promlib
```

### PR canaries — `plan-npm-canary.js`, `verify-npm-canary-tarball.js`

A maintainer opts a same-repository pull request into an npm canary publish by
applying the `npm-canary` label. The pull request must add a Changeset for
`@grafana/prometheus` — PRs whose Changesets only target other packages skip
without publishing. To get a canary for a spike that genuinely needs no
changelog entry, add a throwaway `patch` Changeset for the package.

Once published, the workflow comments the install command on the pull request:

```bash
npm install @grafana/prometheus@<exact-version>
```

#### How it works

1. **`npm-canary-build.yml`** runs in the pull request's unprivileged context.
   For a labelled same-repository PR it builds the package, computes the canary
   version with `plan-npm-canary.js`, packs a `.tgz`, and uploads it as an
   artifact named after that exact run and attempt. It has read-only repository
   access, no npm OIDC permission and no protected environment.
2. **`release-npm.yml`** (the default-branch copy) picks the finished build up
   through `workflow_run`. Trusted code re-reads the pull request from the API
   and requires it to still be open, same-repository, labelled, targeted at the
   default branch, and unchanged at the head that was built. It then downloads
   the artifact — pinned to that run ID and attempt — and validates the packed
   manifest.
3. After approval through the `npm-publish` environment, the publish job
   re-checks the pull request and re-validates the tarball, then publishes the
   exact `.tgz` with `--tag canary --ignore-scripts`. It never checks out,
   installs from, builds or executes pull request code.

#### What actually makes this safe

The tarball is packed by the unprivileged workflow, so **everything inside it,
including its version, is chosen by the pull request**. The build's own claims
about what it produced are not evidence of anything. What publishing relies on
instead is:

- the job holding npm's OIDC token never runs pull request code, so a malicious
  build script cannot reach the publishing credentials;
- only same-repository pull requests are eligible, so the author already needs
  write access, and forks are excluded outright;
- a human has to approve the `npm-publish` environment before any credential
  exists; and
- `verify-npm-canary-tarball.js` requires the packed manifest to name
  `@grafana/prometheus` and to carry a version whose prerelease identifiers are
  exactly the PR number, run ID and run attempt that trusted code resolved for
  itself.

That last check is what stops a canary being published as a plain release,
resolving in place of one, or being attributed to another pull request or run.
The label is an opt-in signal, not an authorization boundary, and the Changeset
requirement is policy rather than security — which is why it lives in the
unprivileged build.

#### Version numbering

```text
<next-version>-canary.<pr-number>.<run-id>.<run-attempt>
```

`<next-version>` is the release the PR's **own** Changesets ask for, relative to
the version on its merge base. Changesets already merged to `main` but not yet
released are deliberately ignored, so if `main` has a pending `minor` while your
PR adds a `patch`, the canary reads `13.1.12-canary…` even though the next real
release will be `13.2.0`. Nothing resolves to a prerelease, so this only affects
how the version reads.

The trusted side intentionally does not constrain `<next-version>`; it only
constrains the suffix. That keeps the publish workflow free of a dependency
install and keeps the checks that matter small enough to audit.

#### Repository setup

Administrators must create the `npm-canary` label. Keep the `npm-publish`
environment restricted to the default branch with required reviewers enabled,
and prevent authors from approving their own deployment. npm's trusted publisher
must continue to authorize `release-npm.yml` and, when an environment is
configured in npm, the `npm-publish` environment. No long-lived npm token is
involved.

Canary publishes set `NPM_CONFIG_PROVENANCE=false`. The tarball is built from
the pull request head but published from the default branch, so npm's automatic
provenance would attest a commit that does not contain the published code and
record that permanently in a public transparency log.

Manual stable publishing remains a separate `workflow_dispatch` path with its
existing tag selection. A canary always uses `--tag canary` and can never move
`latest`.

## Tests — `__tests__/`

Jest tests run end-to-end against the real `@changesets/cli` binary, but
inside an isolated temp-directory monorepo built by `fixture.js`. They cover
both flag-driven and interactive flows, the hold/restore behavior,
multi-package isolation, and the stub → real-location mirroring.

The canary tests parse real Changeset content with `@changesets/parse` and stub
only `git`. `verify-npm-canary-tarball.js` is covered by the versions it must
reject, since that is the check the publish workflow depends on.

Run with:

```bash
npx jest scripts/__tests__ --no-watch
```
