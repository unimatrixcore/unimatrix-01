import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ControlPanel from "../src/original/ControlPanel.js";
import { usePokerStore } from "../src/original/store.js";
import { game } from "./fixtures.js";

const request = vi.hoisted(() =>
  vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve(null),
  ),
);
vi.mock("../src/original/invoke.js", () => ({ invoke: request }));
const colors = {
  card_text: "#ffffff",
  dim_text: "#aaaaaa",
  suits: { clubs: "#00aa00", diamonds: "#0000ff", hearts: "#ff0000", spades: "#ffffff" },
  dim_suits: { clubs: "#005500", diamonds: "#000055", hearts: "#550000", spades: "#aaaaaa" },
};
const available = {
  state: "available",
  reason: "",
  capture_age_ms: 1,
  frame_id: "frame-1",
  ocr_regions: {},
  game_state: {
    ...game.state,
    seat_banks: {},
    seat_statuses: {},
    seat_dealers: {},
    pot: "Pot: G 5 BB",
    split_pot: null,
  },
};

beforeEach(() => {
  request.mockReset();
  request.mockImplementation((command) =>
    Promise.resolve(
      command === "get_monitors"
        ? [{ id: 1, name: "TEST-1", width: 1920, height: 1080, is_primary: true }]
        : command === "get_colors"
          ? colors
          : command === "capture_production_frame"
            ? { capture_id: "one", screenshot_bytes: [137, 80, 78, 71] }
            : command === "extract_regions"
              ? []
              : command === "get_production_state"
                ? available
                : command === "debug_env"
                  ? "Test environment"
                  : null,
    ),
  );
  usePokerStore.setState({
    isRunning: false,
    selectedMonitorIndex: null,
    username: "",
    colors: null,
  });
  usePokerStore.getState().clearGameState();
  URL.createObjectURL = vi.fn(() => "blob:test-capture");
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

async function selectMonitor() {
  await screen.findByRole("option", { name: "TEST-1 (1920x1080) (Primary)" });
  fireEvent.change(screen.getByLabelText("Select Display Monitor:"), { target: { value: "0" } });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("original production-reader interface", () => {
  it("retains the live reader lifecycle and clears authority on stop", async () => {
    render(<ControlPanel />);
    await selectMonitor();
    fireEvent.click(screen.getByRole("button", { name: "Start Assistant" }));
    await screen.findByText(/Status: Reading confirmed game state/);
    expect(usePokerStore.getState().debugInfo.gameId).toBe("#123456");
    expect(screen.getByRole("heading", { name: "Live Assistant HUD" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop Assistant" }));
    await waitFor(() => {
      expect(usePokerStore.getState().isRunning).toBe(false);
      expect(usePokerStore.getState().debugInfo.gameId).toBeNull();
    });
    await waitFor(() => {
      expect(request.mock.calls.some(([command]) => command === "stop_production_ocr")).toBe(true);
    });
  });

  it("rejects a late poll after the user stops the reader", async () => {
    let finish: (value: unknown) => void = () => {};
    const base = request.getMockImplementation();
    request.mockImplementation((command, args) =>
      command === "get_production_state"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : (base?.(command, args) ?? Promise.resolve(null)),
    );
    render(<ControlPanel />);
    await selectMonitor();
    fireEvent.click(screen.getByRole("button", { name: "Start Assistant" }));
    await waitFor(() => {
      expect(request.mock.calls.some(([command]) => command === "get_production_state")).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop Assistant" }));
    await act(async () => {
      finish(available);
      await Promise.resolve();
    });
    expect(usePokerStore.getState().debugInfo.gameId).toBeNull();
    expect(usePokerStore.getState().isRunning).toBe(false);
  });
  it("retains the original controls and native preference writes", async () => {
    render(<ControlPanel />);
    await selectMonitor();
    expect(screen.getByRole("heading", { name: "Stake Poker Assistant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Assistant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Test Capture" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Your Stake Username:"), {
      target: { value: "Player1" },
    });
    expect(usePokerStore.getState().username).toBe("Player1");
    await waitFor(() => {
      expect(
        request.mock.calls.some(
          ([command, args]) =>
            command === "save_preferences" && String(args?.value).includes("Player1"),
        ),
      ).toBe(true);
    });
  });
  it("publishes a confirmed read then revokes it at the original freshness deadline", async () => {
    render(<ControlPanel />);
    await selectMonitor();
    fireEvent.click(screen.getByRole("button", { name: "Test Capture" }));
    await screen.findByText(/Status: Reading confirmed game state/);
    expect(usePokerStore.getState().debugInfo.gameId).toBe("#123456");
    await screen.findByText(/Status: Waiting for a fresh read/, {}, { timeout: 2500 });
    expect(usePokerStore.getState().debugInfo.gameId).toBeNull();
  });
  it("never grants stale output display authority", async () => {
    request.mockImplementation((command) =>
      Promise.resolve(
        command === "get_monitors"
          ? [{ id: 1, name: "TEST-1", width: 1920, height: 1080, is_primary: true }]
          : command === "get_colors"
            ? colors
            : command === "capture_production_frame"
              ? { capture_id: "one", screenshot_bytes: [137, 80, 78, 71] }
              : command === "extract_regions"
                ? []
                : command === "get_production_state"
                  ? { ...available, capture_age_ms: 2000, reason: "stale" }
                  : null,
      ),
    );
    render(<ControlPanel />);
    await selectMonitor();
    fireEvent.click(screen.getByRole("button", { name: "Test Capture" }));
    await screen.findByText(/Status: Waiting for a fresh read/);
    expect(usePokerStore.getState().debugInfo.inPlaySeats).toEqual([]);
  });
  it("shows native failures and keeps prior state cleared", async () => {
    render(<ControlPanel />);
    await selectMonitor();
    request.mockRejectedValueOnce(new Error("Target no longer exists"));
    fireEvent.click(screen.getByRole("button", { name: "Test Capture" }));
    await screen.findByText(/Target no longer exists/);
    expect(usePokerStore.getState().debugInfo.gameId).toBeNull();
  });
});
