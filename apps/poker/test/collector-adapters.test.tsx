import { Gameplay } from "../src/collector/gameplay.js";
import * as backgroundLists from "../src/lib/background-lists.js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { enhanceFormControls } from "../src/collector/form_controls.js";
import { CaptureList, CaptureListCard } from "../src/collector/capture_list.js";
import {
  previewRegions,
  gameplayMaskPaths,
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
import { InstantListProvider } from "@unimatrix/instant-list";
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

  it("renames and archives gameplay recordings through the original tools", async () => {
    const renamed = vi.fn().mockResolvedValue(undefined),
      archived = vi.fn().mockResolvedValue(undefined),
      restored = vi.fn().mockResolvedValue(undefined),
      created = vi.fn();
    render(
      <InstantListProvider>
        <RecordingTools
          current={{ id: "recording", name: "Current recording", frame_count: 2 }}
          disabled={false}
          onNew={created}
          onRename={renamed}
          onArchive={archived}
          onRestore={restored}
          archivedOptions={{
            queryKey: ["archived-test"],
            getItemId: (item: { id: string; name: string; frame_count: number }) => item.id,
            fetchPage: () =>
              Promise.resolve({
                items: [{ id: "old", name: "Archived recording", frame_count: 1 }],
                nextCursor: null,
              }),
          }}
          archivedPrefetch={{ onFocus: () => {}, onMouseEnter: () => {} }}
        />
      </InstantListProvider>,
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
  it("uses current ledger status while preserving original OCR provenance", () => {
    const original = {
      ...frame,
      ocr_status: "complete",
      results: {
        ...frame.results,
        round_id: {
          rect: { x: 18, y: 70, w: 230, h: 36 },
          error: null,
          prediction: { text: "#123456", schema_valid: true, suggestion_only: true },
        },
      },
    };
    const rendered = render(<GameplayPreview frame={original} />);
    expect(screen.getByLabelText("Frame verification: Unverified OCR")).toBeInTheDocument();
    rendered.rerender(
      <GameplayPreview
        frame={{
          ...original,
          verification: {
            region_profile_id: "current-profile",
            status: "partial",
            total: 159,
            verified: 149,
            unverified: 0,
            needs_review: 0,
            unsupported: 10,
          },
        }}
      />,
    );
    expect(
      screen.getByLabelText("Frame verification: Partial · 149/159 · 10 unsupported"),
    ).toBeInTheDocument();
    expect(original.results.round_id.prediction.suggestion_only).toBe(true);
  });
  it("shows accepted and unresolved ledger outcomes without inferring from OCR completion", () => {
    const verification = {
      region_profile_id: "current-profile",
      total: 159,
      verified: 159,
      unverified: 0,
      needs_review: 0,
      unsupported: 0,
    };
    const rendered = render(
      <GameplayPreview
        frame={{ ...frame, verification: { ...verification, status: "verified" } }}
      />,
    );
    expect(screen.getByLabelText("Frame verification: Verified · 159/159")).toBeInTheDocument();
    rendered.rerender(
      <GameplayPreview
        frame={{
          ...frame,
          verification: { ...verification, status: "needs_review", verified: 158, needs_review: 1 },
        }}
      />,
    );
    expect(
      screen.getByLabelText("Frame verification: Needs review · 158/159 · 1 need review"),
    ).toBeInTheDocument();
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

describe("baseline region identity projection", () => {
  it("keeps old IDs/CV indices and draws only resolved OCR fields", () => {
    const prediction = (text: string) => ({
      rect: { x: 0, y: 0, w: 1, h: 1 },
      prediction: { text, schema_valid: true },
      error: null,
    });
    const frame: GameplayPreviewFrame = {
      id: "baseline",
      hand_id: "89612405",
      captured_at: "2026-11-14T00:00:00Z",
      image_url: "/api/gameplay/frames/baseline/image",
      width: 1920,
      height: 1080,
      effective_config_snapshot: {
        region_profile_id: "source104",
        regions: {
          viewport: { width: 1920, height: 1080 },
          legacy_seat_offset: 0,
          regions: [
            { id: "seats[3].name", bounds: { x: 303, y: 550, width: 200, height: 40 } },
            {
              id: "seats[3].nameplate",
              ocr: false,
              overlay: false,
              bounds: { x: 303, y: 550, width: 200, height: 80 },
            },
            { id: "seats[3].bet", bounds: { x: 532, y: 526, width: 99, height: 35 } },
          ],
        },
      },
      effective_results: {
        round_id: prediction("#89612405"),
        pot: prediction("Pot: S 31 BB"),
        split_pot: prediction("S 235.5 BB S 37.5 BB"),
        "seats[3].name": prediction("GalacticAce"),
        "seats[3].cards[0]": prediction("A"),
        "seats[3].cards[0].suit": prediction("d"),
        "seats[3].status": prediction("Fold"),
      },
      color_state: {
        configuration: "recorded",
        community_suits: [null, null, null, null, null],
        seats: { "3": { in_play: true, hand_suits: ["d", "h"] } },
      },
    };
    const state = suspectedGameState(frame);
    expect(state.hand).toBe("#89612405");
    expect(state.pot).toBe("Pot: S 31 BB");
    expect(state.splitPot).toBe("S 235.5 BB S 37.5 BB");
    expect(state.seats).toHaveLength(1);
    expect(state.seats[0]).toMatchObject({
      index: 3,
      name: "GalacticAce",
      status: "Fold",
      cards: ["A", null],
      suits: ["d", "h"],
      inPlay: true,
    });
    expect(previewRegions(frame, 1920, 1080).map((region) => region.key)).toEqual([
      "seats[3].name",
      "seats[3].bet",
    ]);
    expect(previewRegions(frame, 1920, 1080)[1]!.rect).toEqual({ x: 532, y: 526, w: 99, h: 35 });
  });
});

it("round panel outlines retain the shared nameplate parent and each split-list panel", () => {
  const corner = { x: 8, y: 8 };
  const paths = gameplayMaskPaths(
    {
      policy: "source_css_rounded_panels_rgb_v1",
      source: "chip_columns_value",
      neutral_rgb: [15, 33, 46],
      panels: [
        {
          bounds: { x: 0, y: 0, width: 100, height: 32 },
          corners: [corner, corner, corner, corner],
        },
        {
          bounds: { x: 110, y: 0, width: 150, height: 32 },
          corners: [corner, corner, corner, corner],
        },
      ],
    },
    { x: 800, y: 550 },
  );
  expect(paths).toHaveLength(2);
  expect(paths[0]).toContain("M 808,550 H 892");
  expect(paths[1]).toContain("M 918,550 H 1052");
  const shared = gameplayMaskPaths(
    {
      policy: "source_css_rounded_panels_rgb_v1",
      source: "sp_default_nameplate",
      neutral_rgb: [15, 33, 46],
      panels: [
        {
          bounds: { x: 0, y: -40, width: 200, height: 80 },
          corners: [corner, corner, corner, corner],
        },
      ],
    },
    { x: 303, y: 590 },
  );
  expect(shared[0]).toContain("M 311,550");
});

it("lists recordings across collections without changing the saved selection or archive boundary", async () => {
  const sessions = [
    { id: "tigard", name: "11/13/26 - Tigard #17", frame_count: 332 },
    { id: "legacy-a", name: "Legacy recording A", frame_count: 3000 },
    { id: "legacy-b", name: "Legacy recording B", frame_count: 2545 },
  ].map((item) => ({
    ...item,
    source: item.id.startsWith("legacy-") ? `legacy-benchmark:${item.id}` : "TEST-1",
    interval_ms: 1000,
    status: "stopped",
    created_at: "2026-11-13T00:00:00Z",
    hand_count: 1,
  }));
  localStorage.setItem(
    "poker-lab:workspace:v1",
    JSON.stringify({ gameplay: { sessionId: "tigard", collectionId: "legacy", view: "games" } }),
  );
  const original = backgroundLists.labListOptions;
  const options = vi.spyOn(backgroundLists, "labListOptions").mockImplementation((input) => ({
    ...original(input),
    fetchPage: () =>
      Promise.resolve({
        items:
          input.path === "/api/gameplay" && input.query?.archived === "0"
            ? [sessions[1], sessions[2], sessions[0]].map(input.parseItem)
            : [],
        nextCursor: null,
      }),
  }));
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ sources: [{ name: "TEST-1" }] }),
  } as Response);
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  backgroundLists.labQueryClient.clear();
  const view = render(
    <backgroundLists.LabQueryProvider>
      <Gameplay active onLeave={{ current: async () => {} }} />
    </backgroundLists.LabQueryProvider>,
  );
  try {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Recording session" })).toHaveTextContent(
        "11/13/26 - Tigard #17",
      ),
    );
    expect(screen.queryByLabelText("Gameplay collection")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recording session" }));
    expect(
      screen.getByLabelText("Recording sessions").querySelectorAll("button")[0],
    ).toHaveTextContent("11/13/26 - Tigard #17");
    for (const item of sessions)
      expect(
        await screen.findByRole("button", { name: `${item.name} · ${item.frame_count} frames` }),
      ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Legacy recording B · 2545 frames" }));
    expect(screen.getByRole("button", { name: "Recording session" })).toHaveTextContent(
      "Legacy recording B",
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage recordings" }));
    await screen.findByLabelText("Archived recordings");
    const catalogs = options.mock.calls
      .map(([input]) => input)
      .filter((input) => input.path === "/api/gameplay");
    expect(catalogs.some((input) => input.query?.archived === "1")).toBe(true);
    expect(catalogs.every((input) => !input.query?.collection_id)).toBe(true);
  } finally {
    view.unmount();
    options.mockRestore();
    fetchMock.mockRestore();
    height.mockRestore();
    width.mockRestore();
    localStorage.clear();
    backgroundLists.labQueryClient.clear();
  }
});

it("keeps a saved frame and pauses recording after an enrichment failure", async () => {
  localStorage.clear();
  sessionStorage.clear();
  backgroundLists.labQueryClient.clear();
  const session = {
    id: "saved",
    name: "Saved",
    source: "TEST-1",
    interval_ms: 1000,
    status: "recording",
    created_at: "2026-01-01T00:00:00Z",
    frame_count: 1,
    hand_count: 0,
  };
  const fetchPath = (input: RequestInfo | URL) =>
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = fetchPath(input);
    const body = path.endsWith("/sources")
      ? { sources: [{ name: "TEST-1" }] }
      : path.endsWith("/capture")
        ? {
            session,
            frame: {
              id: "saved-frame",
              session_id: "saved",
              hand_id: null,
              captured_at: "2026-01-01T00:00:00Z",
              image_url: "/saved.png",
              ocr_status: "partial",
              error: null,
              effective_region_error: "fixture enrichment failure",
            },
          }
        : path.endsWith("/sessions") && init?.method === "POST"
          ? { session }
          : { sessions: [], hands: [], frames: [], total: 0 };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
  const view = render(
    <backgroundLists.LabQueryProvider>
      <Gameplay active onLeave={{ current: async () => {} }} />
    </backgroundLists.LabQueryProvider>,
  );
  try {
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
    const timers = vi.spyOn(globalThis, "setTimeout");
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(
      await screen.findByText(/Frame saved, but region details could not be loaded/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
    expect(
      timers.mock.calls.some(
        ([callback, delay]) => delay === 1000 && String(callback).includes("capture"),
      ),
    ).toBe(false);
    timers.mockRestore();
    expect(
      fetchMock.mock.calls.filter(([url]) => fetchPath(url).endsWith("/capture")),
    ).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    view.unmount();
    fetchMock.mockRestore();
    localStorage.clear();
    sessionStorage.clear();
    backgroundLists.labQueryClient.clear();
  }
});
