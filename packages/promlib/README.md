# promlib

This package exists **only for versioning purposes**.

`@changesets/cli` cannot target `pkg/promlib` (it lives outside the `packages/*`
workspace glob and is a Go module, not an npm package), so this stub package
stands in for it: its `version` and `CHANGELOG.md` are bumped by
`changeset version`, and `scripts/sync-changelog.js` mirrors the resulting
`CHANGELOG.md` to `pkg/promlib/CHANGELOG.md`. There is no source code here and
nothing should be added.

The actual Go module version of `pkg/promlib` is published via git tags of the
form `pkg/promlib/vX.Y.Z` — see `pkg/promlib/README.md`. The version recorded
in this stub's `package.json` is a bookkeeping mirror of the latest such tag so
that `changeset version` can bump it correctly.

See `scripts/version-changeset.js` for the full flow.
