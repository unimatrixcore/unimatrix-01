import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstantVirtualGrid } from "../src/instant-virtual-grid";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("groups cards responsively while keeping the rendered set bounded", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 650,
    height: 400,
    top: 0,
    left: 0,
    right: 650,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(650);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("role") !== null || target.hasAttribute("data-index")) return;
        this.callback([{ target, contentRect: { width: 650 } } as ResizeObserverEntry], this);
      }
      disconnect = disconnect;
      unobserve() {}
    },
  );
  const items = Array.from({ length: 1000 }, (_, id) => ({ id }));
  const { container, unmount } = render(
    <InstantVirtualGrid
      items={items}
      getItemId={(item) => item.id}
      renderItem={(item, index) => (
        <span>
          {item.id}:{index}
        </span>
      )}
      rowHeight={100}
      minColumnWidth={200}
      height={400}
      ariaLabel="Cards"
    />,
  );
  await waitFor(() => {
    expect(container.querySelector('[style*="repeat(3"]')).not.toBeNull();
  });
  expect(screen.getByText("0:0")).toBeTruthy();
  expect(screen.getAllByRole("listitem").length).toBeLessThan(100);
  unmount();
  expect(disconnect).toHaveBeenCalled();
});
