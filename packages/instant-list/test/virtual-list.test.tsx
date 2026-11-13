import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InstantListProvider, InstantVirtualList } from "../src/instant-virtual-list";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function geometry() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 400,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
}
it("windows large lists with stable geometry and IDs", async () => {
  geometry();
  const items = Array.from({ length: 10000 }, (_, id) => ({ id }));
  const { container, rerender } = render(
    <InstantVirtualList
      items={items}
      getItemId={(item) => item.id}
      renderItem={(item) => <span>Row {item.id}</span>}
      rowHeight={40}
      height={400}
      ariaLabel="Records"
    />,
  );
  await waitFor(() => {
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });
  expect(screen.getAllByRole("listitem").length).toBeLessThan(30);
  expect(screen.getByRole("list").style.scrollbarGutter).toBe("stable");
  const first = container.querySelector('[data-index="0"]');
  rerender(
    <InstantVirtualList
      items={[...items, { id: 10000 }]}
      getItemId={(item) => item.id}
      renderItem={(item) => <span>Row {item.id}</span>}
      rowHeight={40}
      height={400}
      ariaLabel="Records"
    />,
  );
  expect(container.querySelector('[data-index="0"]')).toBe(first);
});
it("demands only after user intent and does not retry merely when fetching ends", async () => {
  geometry();
  const onEndReached = vi.fn();
  const view = (isFetching: boolean) => (
    <InstantVirtualList
      items={[1, 2]}
      getItemId={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      rowHeight={40}
      height={400}
      onEndReached={onEndReached}
      hasNextPage
      isFetching={isFetching}
    />
  );
  const { rerender } = render(view(false));
  expect(onEndReached).not.toHaveBeenCalled();
  fireEvent.wheel(screen.getByRole("list"), { deltaY: 100 });
  await waitFor(() => {
    expect(onEndReached).toHaveBeenCalledTimes(1);
  });
  rerender(view(true));
  expect(screen.getByRole("status").textContent).toBe("Loading more…");
  rerender(view(false));
  expect(onEndReached).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("list"), { key: "End" });
  await waitFor(() => {
    expect(onEndReached).toHaveBeenCalledTimes(2);
  });
});
it("supports measured table rows, headers and a stable provider", () => {
  geometry();
  render(
    <InstantListProvider>
      <InstantVirtualList
        items={[{ id: 1 }]}
        getItemId={(item) => item.id}
        renderItem={() => (
          <div role="row">
            <span role="cell">One</span>
          </div>
        )}
        rowHeight={40}
        height="100%"
        measureRows
        role="table"
        rowRole="presentation"
        header={
          <div role="row">
            <span role="columnheader">Name</span>
          </div>
        }
        ariaLabel="Table"
      />
    </InstantListProvider>,
  );
  expect(screen.getByRole("table").getAttribute("aria-label")).toBe("Table");
  expect(screen.getByRole("columnheader").textContent).toBe("Name");
});

it("keeps rows visible after partial errors and offers an explicit retry overlay", () => {
  geometry();
  const retry = vi.fn();
  const view = (isFetching: boolean) => (
    <InstantVirtualList
      items={[1]}
      getItemId={(item) => item}
      renderItem={() => <span>Existing row</span>}
      rowHeight={40}
      error={new Error("private backend detail")}
      onRetry={retry}
      isFetching={isFetching}
    />
  );
  const { rerender } = render(view(false));
  expect(screen.getByText("Existing row")).toBeDefined();
  expect(screen.getByRole("alert").textContent).toContain("Could not load more.");
  expect(screen.queryByText("private backend detail")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
  rerender(view(true));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Existing row")).toBeDefined();
});

it("scrolls requested stable IDs into view without resetting retained row state", async () => {
  geometry();
  const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === "number" ? options : (options.top ?? 0);
    queueMicrotask(() => fireEvent.scroll(this));
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(4000);
  const items = Array.from({ length: 100 }, (_, id) => ({ id: `row-${id}` }));
  const view = (selection?: string | number, rows = items) => (
    <InstantVirtualList
      items={rows}
      getItemId={(item) => item.id}
      renderItem={(item) => <input aria-label={item.id} defaultValue={item.id} />}
      rowHeight={40}
      height={400}
      {...(selection === undefined ? {} : { scrollToItemId: selection })}
    />
  );
  const { rerender } = render(view());
  scrollTo.mockClear();
  rerender(view("row-80"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "row-80" })).toBeDefined();
  });
  expect(screen.getByRole("list").scrollTop).toBeGreaterThan(0);
  const input = screen.getByRole("textbox", { name: "row-80" });
  fireEvent.change(input, { target: { value: "local edit" } });
  scrollTo.mockClear();
  rerender(view("row-80", [...items, { id: "row-100" }]));
  expect(screen.getByRole("textbox", { name: "row-80" })).toBe(input);
  expect((input as HTMLInputElement).value).toBe("local edit");
  expect(scrollTo).not.toHaveBeenCalled();
  rerender(view("missing"));
  expect(scrollTo).not.toHaveBeenCalled();
  rerender(view("row-0"));
  await waitFor(() => {
    expect(screen.getByRole("list").scrollTop).toBe(0);
  });
});

it("uses an external scroll owner with a content offset and no nested viewport", async () => {
  geometry();
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(10000);
  const scroller = document.createElement("main");
  document.body.append(scroller);
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              borderBoxSize: [
                { inlineSize: 800, blockSize: target.hasAttribute("data-index") ? 80 : 400 },
              ],
            } as unknown as ResizeObserverEntry,
          ],
          this,
        );
      }
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const bounds = scroller.getBoundingClientRect();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    bounds,
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return { ...bounds, top: this.getAttribute("role") === "list" ? 200 : 0 };
  });
  const onEndReached = vi.fn();
  const { container, unmount } = render(
    <InstantVirtualList
      items={[1, 2]}
      getItemId={(item) => item}
      renderItem={(item) => <span>{item}</span>}
      rowHeight={40}
      measureRows
      getScrollElement={() => scroller}
      onEndReached={onEndReached}
      hasNextPage
    />,
    { container: scroller },
  );
  const list = screen.getByRole("list");
  expect(list.style.overflow).toBe("visible");
  expect(list.style.height).toBe("auto");
  expect(list.hasAttribute("tabindex")).toBe(false);
  expect((container.querySelector('[data-index="0"]') as HTMLElement).style.transform).toBe(
    "translateY(0px)",
  );
  expect(onEndReached).not.toHaveBeenCalled();
  fireEvent.scroll(scroller);
  await waitFor(() => {
    expect(onEndReached).toHaveBeenCalledOnce();
  });
  unmount();
  expect(disconnect).toHaveBeenCalled();
  vi.unstubAllGlobals();
});
