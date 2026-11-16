# Monaco query field

The PromQL Code-mode editor. `MonacoQueryFieldWrapper` → `MonacoQueryFieldLazy` → `MonacoQueryField` is the
chain used by `PromQueryField`; the wrapper adapts the editor's `onRunQuery`/`onBlur` callbacks to the query
row's `onChange`/`onRunQuery`, and the lazy layer keeps Monaco out of the initial bundle. Because the async
wrapper needs the same props as the sync component, the prop type lives on its own in `MonacoQueryFieldProps.ts`.

| File                          | Responsibility                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MonacoQueryField.tsx`        | Mounts Monaco, registers the completion provider, owns editor styles                                                                                         |
| `promql.ts`                   | PromQL language definition registered with Monaco (vendored, MIT)                                                                                            |
| `getOverrideServices.ts`      | `storageService` workaround that auto-opens the completion detail popup                                                                                      |
| `monaco-completion-provider/` | Autocomplete: `situation.ts` classifies the cursor position, `data_provider.ts` fetches metrics/labels/history, `completions.ts` turns both into suggestions |

## Query coauthoring

This folder supports inline v1 and floating-Assistant v2. Start with the
[coauthoring overview](../../query_coauthoring/README.md) for both data flows and
[CONTEXT.md](../../query_coauthoring/CONTEXT.md) for the v2 reference and review checklist.
Core owns entry UI and panel previews; the floating Assistant owns v2 chat. This folder reports editor facts
and provides the selection anchor. The v1 path also provides the portal target for Core's inline UI.

- **`usePrometheusQueryCoauthoring.ts`** — the React lifecycle. It returns the Monaco `onMount` handler and
  follows host/editor changes. A supported v2 host registers the editor handle and suppresses the v1 adapter;
  removing it allows v1 to register again. Current query values are read through refs across re-renders.

- **`registerCoauthoringEditor.ts`** — the v2 handle. It reports selection ranges and an anchor, forwards the
  shortcut, and replaces or clears whole-line change marks. Props-driven proposed text is distinguished from
  typing using the current query prop. Disposal releases the host registration, marks, widget and listeners.

- **`MonacoQueryCoauthoringHost.ts`** — the v1 editor-side surface. It settles selection changes into a stable
  `hidden` / `selection` / `invoked` mode, registers the `Cmd/Ctrl + .` action, and manages a Monaco content
  widget whose DOM node is the portal target Core renders into. It also keeps that widget inside the visual
  viewport, which Monaco does not do for overflowing content widgets. No PromQL knowledge lives here.

- **`PrometheusQueryCoauthoringAdapter.ts`** — the v1 adapter Core holds. It joins the host's editor
  events to the PromQL intelligence layer, tracks the active invocation and its id, and translates host modes
  into `QueryEditorCoauthoringSnapshotV1`. Invocation ids are what make stale proposals cheap to reject: every
  `readInvocation`/`prepareProposal` call must name the invocation that is still current.

The PromQL-specific work — context capture, enrichment, validation, and diffing — deliberately lives outside
this folder in `../../query_coauthoring`, so it stays testable without Monaco.
