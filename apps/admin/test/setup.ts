import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library's default 1000ms `asyncUtilTimeout` is independent of Vitest's
// `testTimeout`, and it is what `findBy*` races. Suites that await a lazy chunk
// blow past 1000ms whenever `pnpm verify` runs builds, lint, and typecheck
// alongside the tests, so the budget is raised — but deliberately kept well
// under the `testTimeout` in `vitest.config.ts`, which explains why the two
// must not be equal.
configure({ asyncUtilTimeout: 5000 });

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no `matchMedia`, and `useIsMobile` (reached by the Content
// section's posts table) calls it unconditionally.
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

// jsdom ships no `ResizeObserver`, and `GraphBackground` (mounted by
// `ToolShell`) constructs one unconditionally on mount — any suite rendering
// the shell throws without this inert default. Same shim as
// `packages/chrome/test/setup.ts` and `packages/ui/test/setup.ts`.
if (!("ResizeObserver" in globalThis)) {
  class NoopResizeObserver implements ResizeObserver {
    readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver;
}

// jsdom has no layout; virtualized viewports need deterministic dimensions.
Object.defineProperties(Element.prototype, {
  clientHeight: {
    configurable: true,
    get() {
      return 480;
    },
  },
  clientWidth: {
    configurable: true,
    get() {
      return 800;
    },
  },
});

afterEach(() => {
  cleanup();
});
