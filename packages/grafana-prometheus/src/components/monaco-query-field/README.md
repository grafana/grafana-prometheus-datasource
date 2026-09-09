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

Three files in this folder implement the Monaco half of the query coauthoring experiment. The contract, the
end-to-end data flow, and the Core/Prometheus ownership split are documented in
[`../../query_coauthoring/README.md`](../../query_coauthoring/README.md) — read that first. In short: Grafana's
query row owns the UI, the Assistant request, and the panel preview; this folder owns the editor events, the
anchored DOM node the Core surface is portalled into, and the handoff to the PromQL layer.

- **`usePrometheusQueryCoauthoring.ts`** — the React lifecycle. It returns the Monaco `onMount` handler, creates
  and disposes the adapter when the editor mounts, registers the adapter with Core's private registrar, and
  keeps the portal class name current. Everything else is read through refs so the adapter survives re-renders.
  This is the whole surface area the experiment adds to `MonacoQueryField`: one hook call and one mount handoff,
  so it can be removed without unpicking the ordinary editor lifecycle.

- **`MonacoQueryCoauthoringHost.ts`** — the editor-side surface. It settles selection changes into a stable
  `hidden` / `selection` / `invoked` mode, registers the `Cmd/Ctrl + .` action, and manages a Monaco content
  widget whose DOM node is the portal target Core renders into. It also keeps that widget inside the visual
  viewport, which Monaco does not do for overflowing content widgets. No PromQL knowledge lives here.

- **`PrometheusQueryCoauthoringAdapter.ts`** — the adapter Core actually holds. It joins the host's editor
  events to the PromQL intelligence layer, tracks the active invocation and its id, and translates host modes
  into `QueryEditorCoauthoringSnapshotV1`. Invocation ids are what make stale proposals cheap to reject: every
  `readInvocation`/`prepareProposal` call must name the invocation that is still current.

The PromQL-specific work — context capture, enrichment, validation, and diffing — deliberately lives outside
this folder in `../../query_coauthoring`, so it stays testable without Monaco.
