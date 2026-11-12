import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { enhanceFormControls } from "../src/collector/form_controls.js";
import { CaptureList, CaptureListCard } from "../src/collector/capture_list.js";
import {
  previewRegions,
  suspectedGameState,
  hasSuspectedSeatReading,
  GameplayPreview,
  type GameplayPreviewFrame,
} from "../src/collector/gameplay_preview.js";
import {
  NativeRecordingSlot,
  RecordingPanel,
  RecordingSource,
  setRecordingSourceOpen,
} from "../src/collector/recording_panel.js";
import { RecordingTools } from "../src/collector/recording_tools.js";
import { WorkspaceTopbar } from "../src/collector/workspace_topbar.js";
import { CaptureEmptyState } from "../src/collector/capture_empty_state.js";
import { recordingKeys } from "../src/collector/record_keys.js";
import {
  closeMenus,
  disposeMenus,
  enhanceCollectionMenus,
} from "../src/collector/collection_card_menu.js";

describe("retained collector React adapters", () => {
  it("adopts original field nodes without losing identity, values, options or native handlers", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<input id="name" value="Draft" class="collector-field" style="width:180px;border:1px solid red"><select id="source"><option value="window">Window</option></select><input type="checkbox" id="check">';
    document.body.appendChild(host);
    const input = host.querySelector<HTMLInputElement>("#name");
    const select = host.querySelector<HTMLSelectElement>("#source");
    if (!input || !select) throw new Error("Missing original fields");
    const changed = vi.fn();
    input.onchange = changed;
    act(() => {
      enhanceFormControls(host);
    });
    expect(document.getElementById("name")).toBe(input);
    expect(document.getElementById("source")).toBe(select);
    expect(input).toHaveValue("Draft");
    expect(select).toHaveValue("window");
    expect(input).toHaveAttribute("data-shared-form", "true");
    expect(input.style.width).toBe("180px");
    expect(input.style.border).toBe("");
    fireEvent.change(input, { target: { value: "Edited" } });
    expect(changed).toHaveBeenCalledOnce();
    act(() => {
      enhanceFormControls(host);
    });
    expect(host.querySelectorAll("#name")).toHaveLength(1);
    expect(host.querySelector("#check")).not.toHaveAttribute("data-shared-form");
    host.remove();
  });

  it("retains card identity while React updates only the open callback", () => {
    const first = vi.fn(),
      second = vi.fn();
    const construct = vi.fn((options: { onOpen: () => void }) => {
      const node = document.createElement("button");
      node.textContent = "Original card";
      node.onclick = options.onOpen;
      return node;
    });
    window.PokerLabList = { createCard: construct };
    const view = render(
      <CaptureList label="Captured frames">
        <CaptureListCard
          id="capture"
          label="Hand #123456"
          openLabel="Open capture"
          onOpen={first}
          className="original-card"
        />
      </CaptureList>,
    );
    const card = screen.getByRole("button", { name: "Original card" });
    expect(card).toHaveClass("original-card");
    fireEvent.click(card);
    expect(first).toHaveBeenCalledOnce();
    view.rerender(
      <CaptureList label="Captured frames">
        <CaptureListCard
          id="capture"
          label="Hand #123456"
          openLabel="Open capture"
          onOpen={second}
          className="original-card"
        />
      </CaptureList>,
    );
    expect(screen.getByRole("button", { name: "Original card" })).toBe(card);
    fireEvent.click(card);
    expect(second).toHaveBeenCalledOnce();
    expect(construct).toHaveBeenCalledOnce();
    view.unmount();
    expect(card).not.toBeInTheDocument();
  });

  it("preserves keyboard capture rules while editable fields and native buttons keep their keys", () => {
    const context = {
      collection: true,
      modalOpen: false,
      popoverOpen: false,
      recording: false,
      captureBusy: false,
      previewActive: false,
      editable: false,
      nativeSpace: false,
    };
    expect(recordingKeys.resolveKey({ key: "c" }, context)).toBe("capture");
    expect(recordingKeys.resolveKey({ key: "w" }, context)).toBe("toggle");
    expect(recordingKeys.resolveKey({ key: "Escape" }, { ...context, recording: true })).toBe(
      "stop",
    );
    expect(recordingKeys.resolveKey({ key: "Escape" }, context)).toBeNull();
    expect(recordingKeys.resolveKey({ key: " " }, { ...context, nativeSpace: true })).toBeNull();
    expect(recordingKeys.resolveKey({ key: "c", ctrlKey: true }, context)).toBeNull();
    const input = document.createElement("input");
    expect(recordingKeys.targetContext(input).editable).toBe(true);
    expect(recordingKeys.targetContext(document.createElement("button")).nativeSpace).toBe(true);
    expect(recordingKeys.targetContext(null)).toEqual({ editable: false, nativeSpace: false });
  });

  it("moves recording settings without replacing their native state, and supports the original imperative open bridge", async () => {
    const native = document.createElement("input");
    native.id = "native-monitor";
    native.value = "TEST-1";
    const view = render(
      <RecordingPanel
        header="Collected crops"
        status="Ready"
        detail="Every 2s"
        source={
          <RecordingSource id="record-source" label="TEST-1">
            <NativeRecordingSlot element={native} />
          </RecordingSource>
        }
        capture={<button>Capture</button>}
        record={<button>Record</button>}
      />,
    );
    expect(screen.getByRole("region", { name: "Recording transport" })).toBeInTheDocument();
    act(() => {
      expect(setRecordingSourceOpen("record-source", true)).toBe(true);
    });
    await waitFor(() => expect(native).toBeVisible());
    expect(document.getElementById("native-monitor")).toBe(native);
    fireEvent.change(native, { target: { value: "WINDOW-1" } });
    act(() => {
      setRecordingSourceOpen("record-source", false);
    });
    act(() => {
      setRecordingSourceOpen("record-source", true);
    });
    expect(document.getElementById("native-monitor")).toHaveValue("WINDOW-1");
    expect(setRecordingSourceOpen("missing", true)).toBe(false);
    view.unmount();
    expect(setRecordingSourceOpen("record-source", true)).toBe(false);
  });

  it("retains the shared topbar and empty-state composition", () => {
    render(
      <>
        <WorkspaceTopbar
          id="workflow-panel"
          ariaLabel="Workflow Navigation"
          leading="Collection Labeling Review Database"
          actions="Dataset controls"
        />
        <CaptureEmptyState
          id="collection-placeholder"
          title="No crops collected"
          description="Press Space or C for one frame."
        />
      </>,
    );
    expect(screen.getByLabelText("Workflow Navigation")).toHaveTextContent(
      "Collection Labeling Review Database",
    );
    expect(screen.getByRole("heading", { name: "No crops collected" })).toBeInTheDocument();
  });

  it("renames, archives and restores gameplay recordings through the original tools", async () => {
    const renamed = vi.fn().mockResolvedValue(undefined),
      archived = vi.fn().mockResolvedValue(undefined),
      restored = vi.fn().mockResolvedValue(undefined),
      created = vi.fn();
    render(
      <RecordingTools
        current={{ id: "recording", name: "Current recording", frame_count: 2 }}
        disabled={false}
        onNew={created}
        onRename={renamed}
        onArchive={archived}
        onRestore={restored}
        loadArchived={vi
          .fn()
          .mockResolvedValue([{ id: "old", name: "Archived recording", frame_count: 1 }])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New recording" }));
    expect(created).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Rename recording" }));
    fireEvent.change(await screen.findByLabelText("Recording name to rename"), {
      target: { value: "Renamed recording" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => {
      expect(renamed).toHaveBeenCalledWith("Renamed recording");
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("Recording name to rename")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage recordings" }));
    await waitFor(() => expect(screen.getByLabelText("Archived recordings")).toHaveValue("old"));
    fireEvent.click(screen.getByRole("button", { name: "Restore selected" }));
    await waitFor(() => {
      expect(restored).toHaveBeenCalledWith("old");
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage recordings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive current recording" }));
    await waitFor(() => {
      expect(archived).toHaveBeenCalledOnce();
    });
  });
});

describe("retained gameplay preview", () => {
  const frame: GameplayPreviewFrame = {
    id: "frame",
    hand_id: "123456",
    captured_at: "2026-11-12T00:00:00Z",
    image_url: "data:image/png;base64,AQID",
    width: 1920,
    height: 1080,
    config_snapshot: {
      regions: {
        seats: [{ name: { x: 100, y: 100, w: 80, h: 20 } }, {}],
        outside: { x: 1900, y: 1000, w: 100, h: 100 },
      },
    },
    results: {
      round_id: {
        rect: { x: 18, y: 70, w: 230, h: 36 },
        prediction: { text: "#123456", schema_valid: true },
        error: null,
      },
      "seats[0].name": {
        rect: { x: 100, y: 100, w: 80, h: 20 },
        prediction: { text: "Player 1", schema_valid: true },
        error: null,
      },
    },
  };
  it("uses valid original-coordinate regions and treats unread seats as unknown", () => {
    expect(previewRegions(frame, 1920, 1080).map((region) => region.key)).toEqual([
      "seats[0].name",
      "round_id",
    ]);
    const state = suspectedGameState(frame);
    expect(state.hand).toBe("#123456");
    expect(state.seats[0]?.name).toBe("Player 1");
    expect(state.seats.filter(hasSuspectedSeatReading)).toHaveLength(1);
    expect(
      suspectedGameState({ ...frame, results: {} }).seats.filter(hasSuspectedSeatReading),
    ).toHaveLength(0);
  });
  it("filters only color-confirmed inactive seats and displays detected suits", () => {
    const colored: GameplayPreviewFrame = {
      ...frame,
      config_snapshot: { regions: { seats: [{}, {}, {}] } },
      results: {
        ...frame.results,
        "community_cards[0]": {
          rect: { x: 1, y: 1, w: 2, h: 2 },
          prediction: { text: "A", schema_valid: true },
          error: null,
        },
        "seats[0].cards[0]": {
          rect: { x: 1, y: 1, w: 2, h: 2 },
          prediction: { text: "K", schema_valid: true },
          error: null,
        },
      },
      color_state: {
        seats: {
          "0": { in_play: true, hand_suits: ["h", null] },
          "1": { in_play: false, hand_suits: [] },
          "2": { in_play: null, hand_suits: [] },
        },
        community_suits: ["s"],
      },
    };
    render(<GameplayPreview frame={colored} />);
    expect(screen.getByLabelText("Community card 1: A♠")).toBeInTheDocument();
    expect(screen.getByLabelText("Seat 1 card 1: K♥")).toBeInTheDocument();
    expect(screen.queryByText("Seat 2")).not.toBeInTheDocument();
    expect(screen.getByText("Seat 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 inactive seat" }));
    expect(screen.getByText("Seat 2")).toBeInTheDocument();
  });
  it("retains preview overlays and the suspected-state display", () => {
    render(<GameplayPreview frame={frame} />);
    expect(screen.getByLabelText("Capture region overlays")).toBeInTheDocument();
    expect(screen.getByText("Player 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open original frame" })).toHaveAttribute(
      "href",
      frame.image_url,
    );
  });
});

it("keeps native collection actions inside the shared menu and disposes their portals", async () => {
  const host = document.createElement("div");
  host.className = "collection-card-menu";
  host.dataset.regionId = "seats[0].name";
  host.dataset.menuLabel = "Capture #123456";
  const remove = document.createElement("button");
  remove.textContent = "Remove crop";
  remove.className = "btn-danger";
  const removed = vi.fn();
  remove.onclick = removed;
  host.appendChild(remove);
  document.body.appendChild(host);
  act(() => {
    enhanceCollectionMenus(document);
  });
  const trigger = screen.getByRole("button", { name: "Crop actions for seats[0].name" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove crop" }));
  expect(removed).toHaveBeenCalledOnce();
  act(() => {
    closeMenus();
  });
  act(() => {
    disposeMenus(host);
  });
  expect(
    screen.queryByRole("button", { name: "Crop actions for seats[0].name" }),
  ).not.toBeInTheDocument();
  host.remove();
});
