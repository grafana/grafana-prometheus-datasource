// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

// `@grafana/runtime`'s GrafanaBootConfig constructor logs
// `console.error("window.grafanaBootData was not set by the time config was initialized")`
// the first time it's evaluated without a host-injected boot payload. The constructor
// runs the moment any module imports `@grafana/runtime` (transitively via @grafana/ui,
// @grafana/plugin-ui, @grafana/assistant, etc.) — including from src/module.ts during
// `jest.isolateModules` re-imports. Pre-populate the global with the same minimal
// shape grafana/grafana uses in `public/test/jest-setup.ts` so the constructor takes
// the happy path and stays quiet.
//
// Use `??=` (and the `(globalThis as any)` cast in JS-as-CJS form below) to avoid
// clobbering anything a future test sets explicitly via Object.defineProperty on
// window.grafanaBootData.
if (typeof window !== 'undefined' && !window.grafanaBootData) {
  window.grafanaBootData = {
    settings: { featureToggles: {} },
    user: { locale: 'en-US' },
    navTree: [],
  };
}

// ResizeObserver is not available in jsdom
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// IntersectionObserver is not available in jsdom
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// @tanstack/react-virtual reads offsetHeight/offsetWidth to decide how many items
// to render in a virtualised list. jsdom returns 0 by default, which causes the
// virtualizer to render nothing. Return a non-zero value so tests can see list items.
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 300 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 300 });

// Return a minimal canvas 2D context so Monaco's measureText calls don't throw.
// The .config/jest-setup.js already patches getContext to return {}; we override
// it here with a richer stub.
HTMLCanvasElement.prototype.getContext = () => ({
  measureText: () => ({ width: 0 }),
  fillText: () => {},
  clearRect: () => {},
  fillRect: () => {},
  getImageData: () => ({ data: [] }),
  putImageData: () => {},
  createImageData: () => [],
  setTransform: () => {},
  drawImage: () => {},
  save: () => {},
  fillStyle: '',
  restore: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  closePath: () => {},
  stroke: () => {},
  translate: () => {},
  scale: () => {},
  rotate: () => {},
  arc: () => {},
  fill: () => {},
  strokeRect: () => {},
  strokeText: () => {},
  createLinearGradient: () => ({ addColorStop: () => {} }),
  createPattern: () => ({}),
  canvas: { width: 0, height: 0 },
});
