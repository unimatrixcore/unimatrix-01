import { describe, expect, it, vi, afterEach } from "vitest";
import {
  drawnBox,
  editorRegions,
  fitView,
  formatVideoTime,
  fromNatural,
  nextUndefined,
  toNatural,
  zoomAt,
} from "../src/region-editor/geometry.js";
import { loadEditorConfig, saveEditorConfig } from "../src/region-editor/api.js";

afterEach(() => vi.unstubAllGlobals());
describe("original region editor geometry", () => {
  it("retains all original regions and next-undefined ordering", () => {
    const regions = editorRegions();
    expect(regions).toHaveLength(80);
    expect(regions[0]?.key).toBe("community.card_1");
    expect(regions.at(-1)?.key).toBe("seat.8.dealer");
    expect(nextUndefined(regions, {})).toBe(1);
    const defined = Object.fromEntries(
      regions.slice(1).map(({ key }) => [key, { x: 0, y: 0, w: 1, h: 1 }]),
    );
    expect(nextUndefined(regions, defined, 79)).toBe(0);
    expect(
      nextUndefined(regions, { ...defined, "community.card_1": { x: 0, y: 0, w: 1, h: 1 } }, 79),
    ).toBe(79);
  });
  it("converts reverse drags through letterbox, zoom and pan to source pixels", () => {
    const view = { ...fitView(1000, 800, 1920, 1080), zoom: 2, panX: -100, panY: 30 };
    const start = fromNatural({ x: 400, y: 300 }, view),
      end = fromNatural({ x: 100, y: 100 }, view);
    expect(toNatural(start, view)).toEqual({ x: 400, y: 300 });
    expect(drawnBox(start, end, view)).toEqual({ x: 100, y: 100, w: 300, h: 200 });
    expect(drawnBox(start, { x: start.x + 4, y: start.y + 40 }, view)).toBeNull();
  });
  it("anchors cursor zoom and resets pan when zoom reaches one", () => {
    const view = fitView(1000, 800, 1920, 1080),
      cursor = { x: 321, y: 234 };
    const zoomed = zoomAt(view, cursor, -100);
    expect(zoomed.zoom).toBe(1.1);
    expect(toNatural(cursor, zoomed).x).toBeCloseTo(toNatural(cursor, view).x);
    expect(zoomAt(zoomed, cursor, 100)).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
    expect(zoomAt({ ...view, zoom: 10 }, cursor, -1).zoom).toBe(10);
    expect(formatVideoTime(125.8)).toBe("2:05");
    expect(formatVideoTime(Infinity)).toBe("0:00");
  });
});
describe("editor API boundary", () => {
  it("preserves signed and out-of-image draft coordinates through export", async () => {
    const payload = {
      regions: { "pot.main": { x: -30, y: -15, w: 2000, h: 100 } },
      screenWidth: 1920,
      screenHeight: 1080,
      export: true,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ saved: true, exportPath: "/tmp/regions.json" }));
    vi.stubGlobal("fetch", fetchMock);
    await saveEditorConfig(payload);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual(payload);
  });
  it("validates load and save and sends explicit export", async () => {
    const config = {
      regions: { "pot.main": { x: 2, y: 3, w: 40, h: 20 } },
      screenWidth: 1920,
      screenHeight: 1080,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(config))
      .mockResolvedValueOnce(Response.json({ saved: true, exportPath: "/tmp/regions.json" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadEditorConfig()).toEqual(config);
    expect(await saveEditorConfig({ ...config, export: true })).toEqual({
      saved: true,
      exportPath: "/tmp/regions.json",
    });
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      ...config,
      export: true,
    });
  });
  it("surfaces failed responses and rejects malformed data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({}, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ error: "Disk full" }, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ regions: [] })),
    );
    await expect(loadEditorConfig()).rejects.toThrow("Could not load");
    await expect(
      saveEditorConfig({ regions: {}, screenWidth: 1920, screenHeight: 1080 }),
    ).rejects.toThrow("Disk full");
    await expect(loadEditorConfig()).rejects.toThrow();
  });
});
