# scripts

Changesets tooling for this repo. We use `@changesets/cli`, but wrap it so that
each release targets exactly **one** package and so that "stub" workspace
packages can stand in for things changesets cannot version directly (the
workspace root and the `pkg/promlib` Go module).

## Packages

| Name                            | Path                                            | What gets versioned                                                                                                                          |
| ------------------------------- | ----------------------------------------------- |----------------------------------------------------------------------------------------------------------------------------------------------|
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
npm run changeset                                        # fully interactive
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
npm run changeset:version                        # interactive
npm run changeset:version -- --datasource        # plugin/root only
npm run changeset:version -- --npm-package       # @grafana/prometheus only
npm run changeset:version -- --promlib           # pkg/promlib only
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

## Tests — `__tests__/`

Jest tests run end-to-end against the real `@changesets/cli` binary, but
inside an isolated temp-directory monorepo built by `fixture.js`. They cover
both flag-driven and interactive flows, the hold/restore behavior,
multi-package isolation, and the stub → real-location mirroring.

Run with:

```bash
npx jest scripts/__tests__ --no-watch
```
