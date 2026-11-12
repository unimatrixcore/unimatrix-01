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
