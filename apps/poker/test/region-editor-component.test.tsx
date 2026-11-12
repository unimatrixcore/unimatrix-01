import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RegionEditor } from "../src/region-editor/editor.js";
import { loadEditorConfig, saveEditorConfig } from "../src/region-editor/api.js";
vi.mock("../src/region-editor/api.js", () => ({
  loadEditorConfig: vi.fn(),
  saveEditorConfig: vi.fn(),
}));
const alertMock = vi.fn();
beforeEach(() => {
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
afterEach(() => vi.restoreAllMocks());
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
