// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';

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
