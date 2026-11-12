import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's default 1000ms `asyncUtilTimeout` is independent of Vitest's
// 5000ms `testTimeout`, and it is what `findBy*` races. Suites that await a lazy
// chunk can blow
// past 1000ms whenever `pnpm verify` runs builds, lint, and typecheck alongside
// the tests, so align the async-util budget with the test timeout.
configure({ asyncUtilTimeout: 5000 });

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Polyfill window.matchMedia for the jsdom environment used by Vitest.
// Some components use matchMedia and will throw without this.
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, // legacy
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Polyfill ResizeObserver for the jsdom environment used by Vitest.
// GraphBackground (mounted in the app shell) observes `documentElement` and
// will throw without this.
class MockResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: MockResizeObserver,
});

afterEach(() => {
  cleanup();
});
