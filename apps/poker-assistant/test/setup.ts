import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }),
});
class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
