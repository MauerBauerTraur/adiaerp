import '@testing-library/jest-dom/vitest';

/**
 * jsdom ships without `ResizeObserver`, but Recharts'
 * `<ResponsiveContainer>` instantiates one on mount (M8 dashboard
 * charts). Provide a no-op polyfill so the chart-bearing screens can
 * render under vitest.
 */
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = ResizeObserverMock;
}

/**
 * jsdom also ships without `IntersectionObserver`, which the ProductsPage
 * (EPIC 1.4c — incremental "infinite scroll") attaches once the result set
 * exceeds the first render window. A no-op stub keeps it from throwing; tests
 * that need to assert lazy loading can drive `setVisibleCount` via scroll
 * fixtures instead.
 */
class IntersectionObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).IntersectionObserver = IntersectionObserverMock;
}

/**
 * Dashboard v3 — Variant B canvas. React Flow renders via SVG and
 * `DOMMatrixReadOnly` on mount; jsdom doesn't ship it, so we polyfill
 * a minimal stub that returns identity values. The canvas test just
 * needs nodes to render — actual matrix math is irrelevant.
 */
if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor() {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

if (
  typeof Element !== 'undefined' &&
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  !(Element.prototype as any).hasPointerCapture
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).hasPointerCapture = () => false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).releasePointerCapture = () => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).setPointerCapture = () => {};
}
