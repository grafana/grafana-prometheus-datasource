// global is used in packages/grafana-prometheus/src for dispatching events outside Monaco.
// It is identical to globalThis in both Node.js and modern browsers.
// eslint-disable-next-line no-var
declare var global: typeof globalThis;
