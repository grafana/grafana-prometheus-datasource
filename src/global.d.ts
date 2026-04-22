// global is used in packages/grafana-prometheus/src for dispatching events outside Monaco.
// It is identical to globalThis in both Node.js and modern browsers.
declare var global: typeof globalThis;
