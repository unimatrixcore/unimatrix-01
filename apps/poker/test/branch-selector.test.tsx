import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BranchSelector } from "../src/collector/branch_selector.js";
import { launcherRequest } from "../src/lib/launcher.js";
vi.mock("../src/lib/launcher.js", () => ({ launcherRequest: vi.fn() }));
const current = { id: "/current", path: "/current", branch: "work/current", head: "a".repeat(40) };
const other = { id: "/other", path: "/other", branch: "work/other", head: "b".repeat(40) };
const status = {
  selection: "latest",
  current,
  desired: current,
  worktrees: [current, other],
  error: null,
};
afterEach(() => {
  vi.mocked(launcherRequest).mockReset();
});
it("renders the active checkout separately from the requested branch using the shared picker", async () => {
  vi.mocked(launcherRequest).mockResolvedValue(status);
  render(<BranchSelector />);
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: "Checkout" })).toBeEnabled();
  });
  expect(screen.queryByLabelText("Active work branch")).not.toBeInTheDocument();
  const trigger = screen.getByRole("combobox", { name: "Checkout" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await screen.findByRole("option", { name: "Latest commit" });
  vi.mocked(launcherRequest).mockResolvedValue({ ...status, selection: other.id, desired: other });
  fireEvent.click(screen.getByRole("option", { name: "work/other" }));
  await waitFor(() => {
    expect(trigger).toHaveTextContent("work/other");
  });
  expect(launcherRequest).toHaveBeenLastCalledWith("select", "/other");
  expect(trigger).toHaveAttribute("title", "work/current → work/other");
});
it("makes launcher failures visible without enabling a disconnected control", async () => {
  vi.mocked(launcherRequest).mockRejectedValue(new Error("Launcher unavailable"));
  render(<BranchSelector />);
  await waitFor(() => {
    expect(screen.getByRole("status")).toHaveTextContent("Launcher unavailable");
  });
  expect(screen.getByRole("combobox", { name: "Checkout" })).toBeDisabled();
});
