# Private Prometheus query coauthoring

This module supports both the existing inline v1 experiment and Query Coauthoring v2
([GRA-3446](https://linear.app/grafana/issue/GRA-3446), GRA-3451 and GRA-3454).
The v2 language capability lives on the shared `PrometheusDatasource` class, and the
editor capability lives in shared Code Mode components. Inheriting plugins receive
both without plugin-ID checks.

## Core reference and contract lifetime

The v2 structural copies in `queryCoauthoringContracts.ts` mirror only the language
and editor declarations used here from:

`grafana/grafana`, commit `1d13fcb5fc8690bde026ab42f06749dd373dec78`,
`public/app/features/dashboard-scene/panel-edit/PanelEditNext/QueryEditor/coauthoring/queryCoauthoringContracts.ts`.

That commit is the inspected head of [Core Surface #137907](https://github.com/grafana/grafana/pull/137907).
Its `QueryCoauthoringEditor.tsx`, `QueryEditorRenderer.tsx`, `useCoauthoringSurface.ts`
and `CONTEXT.md` define the host behavior used here. The Core commit is an integration
reference; the Prometheus branch is based on Prometheus `main`.

All contracts report `version: 1`. The editor validates the host version and both
required functions before using it. The copies remain private: no exports are added
to a Grafana package and no members are added to published `DataSourceApi` or
`QueryEditorProps` interfaces. Coordinate mirrored declaration changes or a version
bump. Remove these copies when this repository pins a Grafana release containing
the reviewed, promoted language/editor contracts.

## Ownership

Core owns entry UI, query selection, session lifetime, telemetry and proposed-query
projection. `queryCoauthoring().describe` provides authored PromQL, guidance and
metadata. `prepare` validates interpolated PromQL, reports changes against authored
text and replaces only `expr` on the full typed baseline.

v1 and v2 share metadata enrichment: at most 20 metrics, label lookups for five
metrics, 30 label keys per metric, and 500 characters of help. Optional lookup
failures leave the text and available metadata usable. Disabled lookups use cached
metadata without requests. `describe` rejects promptly on cancellation and skips
lookups that have not started. Existing language-provider requests have no signal
API and may finish populating their shared caches after cancellation.

The editor registers a handle, reports current highlighted offsets and a Monaco
content-widget anchor, and forwards Cmd/Ctrl+. even without a highlight. Core
interprets absent ranges as whole-query focus. `showChanges` replaces an owned
Monaco decoration collection with whole-line tints at proposed-text ranges; exclusive
ends do not tint the following line. A deletion tints its surviving insertion line.
Typing clears marks and reports the edited proposed query through the ordinary
`onChange` path. Props-driven projection and unchanged blur do not report manual
edits. Model changes, host replacement, editor replacement and unmount clear marks
and release the registration and listeners.

A recognized v2 host suppresses the v1 adapter so shortcuts and selection handlers
have one owner. Absent, malformed or unsupported hosts retain ordinary editing and
any supplied v1 registrar. Removing v2 allows a fresh inline v1 invocation; returning
to v2 creates a fresh registration.

## Tests

The confirmed seams are the datasource language capability (`language.test.ts`) and
the mounted Code Mode editor/host boundary
(`PromQueryCodeEditor.coauthoring.test.tsx`). The latter mounts the real component,
field, hooks and adapters with Monaco simulated at the external browser boundary.
Existing intelligence, structure and v1 adapter tests remain compatibility coverage.
A separate real-Monaco browser probe can validate DOM marks and keyboard input; it
is not a substitute for the built plugin running inside Core or hosted Assistant
acceptance. Delivery validation and its limits are recorded in the PR description.

## Reviewing and trying v2

Suggested review order:

1. `queryCoauthoringContracts.ts` and `language.ts`: the private boundary and datasource behavior.
2. `registerCoauthoringEditor.ts` and `usePrometheusQueryCoauthoring.ts` in
   [`../components/monaco-query-field`](../components/monaco-query-field/README.md): editor facts and v1/v2 switching.
3. `language.test.ts` and `PromQueryCodeEditor.coauthoring.test.tsx`: field preservation, HTTP metadata,
   proposed-text updates and cleanup. The `intelligence.ts` change shares existing metadata enrichment between v1 and v2.

From the repository root, run the focused contract and compatibility tests:

```sh
npx jest --selectProjects library --runInBand --testPathPattern='query_coauthoring|PromQueryCodeEditor.coauthoring|PrometheusQueryCoauthoringAdapter|usePrometheusQueryCoauthoring|MonacoQueryField.test'
```

For a full smoke test, use the Core reference above and follow the
[external plugin setup](../../../../DEVELOPMENT.md#running-locally-against-a-local-grafanagrafana-checkout).
Open a panel in PanelEditNext with a working Prometheus query in Code Mode. Core needs both
`queryeditor.coauthoringUi` and `grafana.visualDesignRefresh` enabled through its feature-flag provider,
plus a registered `queryCoauthoring.onEnterRequested` listener. A compatible floating Assistant supplies that
listener. Flags alone leave v2 inactive; the stock Compose image may not contain the required Core work.
A Core development listener can exercise entry and host wiring without Assistant chat, but cannot by itself
validate Assistant proposals.

Expected smoke checks:

- Highlight text, then invoke from the selection action and `Cmd/Ctrl + .`; repeat the shortcut without a highlight.
- Preview and switch proposal Options. Check proposed text and line tints; ending preview clears the tints.
- Type during a preview. The edited proposed row should become normal query state and its tints should clear.
- Move focus outside the editor and switch applications; selection actions should not remain over an inactive editor.
- Remove the v2 listener with coauthoring still enabled. Verify inline v1 works, then restore v2 and check for duplicate actions.

This is a review checklist, not a record of completed Core/plugin acceptance. The built plugin still needs
validation against the actual Core Surface and hosted Assistant; the local contract tests and Monaco probe cover narrower boundaries.
