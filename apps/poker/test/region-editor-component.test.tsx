import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RegionEditor } from "../src/region-editor/editor.js";
import { editorRegions } from "../src/region-editor/geometry.js";
import { loadEditorConfig, saveEditorConfig } from "../src/region-editor/api.js";
vi.mock("../src/region-editor/api.js", () => ({
  loadEditorConfig: vi.fn(),
  saveEditorConfig: vi.fn(),
}));
const alertMock = vi.fn();
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => {
  vi.clearAllMocks();
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
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1760);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: function (this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
      queueMicrotask(() => {
        if (this.isConnected) fireEvent.scroll(this);
      });
    },
  });
  vi.mocked(loadEditorConfig).mockResolvedValue({
    regions: { "pot.main": { x: 1, y: 2, w: 3, h: 4 } },
    screenWidth: 1920,
    screenHeight: 1080,
  });
  vi.mocked(saveEditorConfig).mockResolvedValue({ saved: true, exportPath: "/tmp/regions.json" });
  alertMock.mockClear();
  vi.spyOn(window, "alert").mockImplementation(alertMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});
it("restores rectangles, clears with keyboard, serializes saves and exports", async () => {
  render(<RegionEditor />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Main Pot" })).toHaveClass("done"));
  fireEvent.click(screen.getByRole("button", { name: "Main Pot" }));
  fireEvent.keyDown(document, { key: "Delete" });
  await waitFor(() => {
    expect(saveEditorConfig).toHaveBeenCalledWith({
      regions: {},
      screenWidth: 1920,
      screenHeight: 1080,
    });
  });
  expect(screen.getByRole("button", { name: "Main Pot" })).not.toHaveClass("done");
  fireEvent.keyDown(document, { key: "Tab" });
  expect(screen.getByRole("button", { name: "Split Pot" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Export regions_final.json" }));
  await waitFor(() => {
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("/tmp/regions.json"));
  });
  expect(saveEditorConfig).toHaveBeenLastCalledWith({
    regions: {},
    screenWidth: 1920,
    screenHeight: 1080,
    export: true,
  });
});
it("shows load and autosave failures without reporting a successful export", async () => {
  vi.mocked(loadEditorConfig).mockRejectedValueOnce(new Error("Load offline"));
  vi.mocked(saveEditorConfig).mockRejectedValueOnce(new Error("Disk full"));
  render(<RegionEditor />);
  await screen.findByText(/Load offline/);
  fireEvent.click(screen.getByRole("button", { name: "Clear selected box" }));
  await screen.findByText(/Disk full/);
  fireEvent.click(screen.getByRole("button", { name: "Export regions_final.json" }));
  await screen.findByText(/EXPORT ERROR/);
  expect(alertMock).not.toHaveBeenCalled();
});

it("reveals the offscreen first undefined region and retains it when it is the only gap", async () => {
  const definitions = editorRegions();
  const regions = Object.fromEntries(
    definitions.slice(0, -1).map((region) => [region.key, { x: 1, y: 2, w: 3, h: 4 }]),
  );
  let resolveConfig!: (value: Awaited<ReturnType<typeof loadEditorConfig>>) => void;
  vi.mocked(loadEditorConfig).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveConfig = resolve;
    }),
  );
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const writes: number[] = [];
  const pendingScrolls: HTMLElement[] = [];
  vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(function (
    this: HTMLElement,
    options,
  ) {
    const top = (options as ScrollToOptions).top ?? 0;
    writes.push(top);
    this.scrollTop = top;
    pendingScrolls.push(this);
  });
  render(<RegionEditor />);
  const last = definitions.at(-1)!;
  await act(async () => {
    resolveConfig({ regions, screenWidth: 1920, screenHeight: 1080 });
    await Promise.resolve();
  });
  expect(writes[0]).toBe(0);
  expect(writes.at(-1)).toBe(1360);
  expect(screen.getByText("Drawing: Seat 8 — Dealer Button")).toBeInTheDocument();
  await act(async () => {
    for (const element of pendingScrolls.splice(0)) fireEvent.scroll(element);
    for (let i = 0; i < 3; i++) {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => {
        callback(performance.now());
      });
      for (const element of pendingScrolls.splice(0)) fireEvent.scroll(element);
    }
    await Promise.resolve();
  });
  expect(writes.at(-1)).toBe(1360);
  expect(screen.getByRole("button", { name: last.label })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("list", { name: "Region definitions" }).scrollTop).toBeGreaterThan(0);
  fireEvent.keyDown(document, { key: "Delete" });
  await waitFor(() => {
    expect(saveEditorConfig).toHaveBeenCalled();
  });
  fireEvent.keyDown(document, { key: "Tab" });
  expect(screen.getByRole("button", { name: last.label })).toHaveAttribute("aria-pressed", "true");
});

it("keeps a single current media view, arrow navigation and object URL cleanup", async () => {
  const create = vi
    .spyOn(URL, "createObjectURL")
    .mockReturnValueOnce("blob:z")
    .mockReturnValueOnce("blob:a")
    .mockReturnValueOnce("blob:replacement");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { unmount } = render(<RegionEditor />);
  await screen.findByRole("button", { name: "Main Pot" });
  const picker = screen.getByLabelText("Open reference images or videos");
  fireEvent.change(picker, {
    target: {
      files: [
        new File([], "z.png", { type: "image/png" }),
        new File([], "a.png", { type: "image/png" }),
      ],
    },
  });
  expect(screen.getByText("a.png (1/2)")).toBeDefined();
  expect(screen.getAllByAltText("Reference screenshot")).toHaveLength(1);
  fireEvent.keyDown(document, { key: "ArrowRight" });
  expect(screen.getByText("z.png (2/2)")).toBeDefined();
  fireEvent.keyDown(document, { key: "ArrowLeft" });
  expect(screen.getByText("a.png (1/2)")).toBeDefined();
  fireEvent.change(picker, {
    target: { files: [new File([], "replacement.webm", { type: "video/webm" })] },
  });
  expect(revoke.mock.calls).toEqual([["blob:a"], ["blob:z"]]);
  unmount();
  expect(revoke.mock.calls).toEqual([["blob:a"], ["blob:z"], ["blob:replacement"]]);
  expect(create).toHaveBeenCalledTimes(3);
});
