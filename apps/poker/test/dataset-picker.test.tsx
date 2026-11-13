import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetPicker } from "../src/collector/dataset_picker";
import { LabQueryProvider, labQueryClient } from "../src/lib/background-lists";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: () =>
    Promise.resolve({
      status: 200,
      headers: {},
      body: {
        items: [
          { id: "one", name: "One", archived: false },
          { id: "two", name: "Two", archived: true },
        ],
        nextCursor: null,
        hasMore: false,
        total: 2,
        meta: { default_dataset_id: "one" },
      },
    }),
}));
afterEach(() => {
  labQueryClient.clear();
  vi.restoreAllMocks();
});

it("adapts catalog changes and restores focus while passing archived selection to the native controller", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 280,
    height: 260,
    top: 0,
    left: 0,
    right: 280,
    bottom: 260,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(260);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(280);
  const changed = vi.fn();
  const select = vi.fn(async () => {});
  const view = render(
    <LabQueryProvider>
      <DatasetPicker activeId="one" activeName="Loading" changed={changed} select={select} />
    </LabQueryProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Working dataset" });
  await waitFor(() => {
    expect(trigger).toHaveTextContent("One");
  });
  expect(changed).toHaveBeenLastCalledWith(
    expect.arrayContaining([expect.objectContaining({ id: "two", archived: true })]),
  );
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  await screen.findByRole("menuitemradio", { name: "One" });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
  const archived = await screen.findByRole("menuitemradio", { name: "Two · Restore" });
  await waitFor(() => {
    expect(archived).toHaveFocus();
  });
  fireEvent.click(archived);
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "two", archived: true }));
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  view.rerender(
    <LabQueryProvider>
      <DatasetPicker activeId="two" activeName="Two" changed={changed} select={select} />
    </LabQueryProvider>,
  );
  expect(trigger).toHaveTextContent("Two");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  await screen.findByRole("menu");
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
  await waitFor(() => {
    expect(screen.getByRole("menuitemradio", { name: "One" })).toHaveFocus();
  });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
});
