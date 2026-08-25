# Prometheus query coauthoring adapter

## Boundary

This is a private bilateral PanelEditNext + Prometheus seam. Prometheus implements the row-scoped `QueryEditorCoauthoringAdapterV1` supplied through the optional private query-editor prop `unstable_queryEditorCoauthoringV1`. The adapter exposes six operations: snapshot, subscription, invocation, invocation reading, proposal preparation, and dismissal.

The datasource does not render coauthoring UI, mutate the editor for proposals, add Monaco proposal decorations, or make the editor read-only. Core displays a proposal by passing the proposed `PromQuery` through the normal query props.

## Modules

- `MonacoQueryCoauthoringHost.ts` owns selection settling, shortcut registration, portal anchoring, viewport positioning, and internal surface measurement. It contains no PromQL logic.
- `PrometheusQueryCoauthoringAdapter.ts` composes editor events and PromQL intelligence into the private row adapter.
- `intelligence.ts` captures an atomic typed baseline, expands focus ranges, enriches PromQL context, validates proposed PromQL, and constructs typed proposals and change summaries.
- `internalCoauthoringContract.ts` is a private type-only copy of the Core contract. The two copies must stay structurally synchronized.

The optional registration can be ignored safely: editors without it retain normal editing behavior. Core injects it only for the `prometheus` plugin type; Amazon Managed Service for Prometheus remains outside this experiment even though it reuses Prometheus editor modules. A second datasource must not copy this seam; it requires a reviewed generalized contract promoted to `@grafana/data`.

## Lifecycle invariants

- Invocation captures `editor.getValue()` synchronously, including unblurred edits.
- Context loading may be asynchronous, but a dismissed or replaced invocation cannot become current again.
- A Core-controlled query prop update is allowed so proposals can appear in Monaco without ending the session.
- A Monaco content change that differs from the current query prop is a genuine manual edit. It invalidates the invocation and immediately follows the normal query `onChange` path.
- Proposal preparation is pure with respect to Monaco. Stale, invalid, and unchanged proposals are rejected without editor mutation.

This paired architecture does not use an exposed component or `plugin.json` extension registration.
