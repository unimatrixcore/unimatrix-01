import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";

const source = readFileSync("public/static/js/app.js", "utf8");
const watch = readFileSync("public/static/js/lib/watch_capture.js", "utf8");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controllerFixture() {
  const saved = {
    lease: "saved-lease",
    datasetId: "one",
    monitor: "screen",
    settings: { intervalSeconds: 2, queueMode: "paged" },
  };
  let reconnectData: string | null = JSON.stringify(saved);
  const storage = {
    getItem: vi.fn(() => reconnectData),
    setItem: vi.fn((_key: string, value: string) => {
      reconnectData = value;
    }),
    removeItem: vi.fn(() => {
      reconnectData = null;
    }),
  };
  const launcher = vi.fn(() => Promise.resolve());
  const render = vi.fn();
  const api = vi
    .fn<(path: string, options: unknown) => Promise<{ ok: boolean; json: () => unknown }>>()
    .mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => ({ lease_id: "new-lease" }) }),
    );
  const elements = new Map<string, { value: string; onclick?: () => void }>();
  const context = createContext({
    window: {
      sessionStorage: storage,
      location: { pathname: "/collection" },
      addEventListener: vi.fn(),
      pokerSetLauncherRecording: launcher,
    },
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "2" });
        return elements.get(id);
      },
      addEventListener: vi.fn(),
    },
    renderWatchStatus: render,
    datasetFetch: api,
    initCaptureToolbar: vi.fn(),
    setRecordingSettingsOpen: vi.fn(),
    saveSessionProgress: vi.fn(() => Promise.resolve()),
    showToast: vi.fn(),
  });
  runInContext(
    `let activeDatasetId='one',datasetEpoch=0,datasetSwitching=false,currentView='collection',isRecovering=false,labelingUnlocked=false,reviewUnlocked=false;
     let monitorSelect={value:'screen',options:[{value:'screen'}]};`,
    context,
  );
  runInContext(
    source.slice(source.indexOf("let captureWatch ="), source.indexOf("function queuedCropCount")),
    context,
  );
  runInContext("queuedCropCount=()=>0;", context);
  runInContext(
    source.slice(
      source.indexOf("async function stopCaptureWatch"),
      source.indexOf("async function stopAndRecoverWatch"),
    ),
    context,
  );
  runInContext(
    source.slice(
      source.indexOf("function initCaptureWatch()"),
      source.indexOf("function reportDatasetError"),
    ),
    context,
  );
  return { context, storage, launcher, render, api };
}

it("storage exceptions cannot escape the watch status callback or prevent rendering", () => {
  const { context, storage, render } = controllerFixture();
  storage.setItem.mockImplementation(() => {
    throw new Error("quota");
  });
  storage.removeItem.mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => {
    runInContext(
      "rememberCaptureWatch({active:true,lease:'lease',context:{datasetId:'one',monitor:'screen'},settings:{}});rememberCaptureWatch({active:false});",
      context,
    );
  }).not.toThrow();
  expect(render).toHaveBeenCalledTimes(2);
});

it("blocked reconnect storage cannot leave a running watch busy or skip its lease close", async () => {
  const { context, storage } = controllerFixture();
  storage.setItem.mockImplementation(() => {
    throw new Error("quota");
  });
  storage.removeItem.mockImplementation(() => {
    throw new Error("blocked");
  });
  const close = vi.fn();
  context.closeLease = close;
  runInContext(watch, context);
  runInContext(
    "captureWatch=window.CollectorWatchCapture.create({getContext:captureContext,canRun:canWatchCapture,onStatus:rememberCaptureWatch,open:async()=>({lease_id:'lease'}),scan:async()=>({added_count:0}),close:closeLease,schedule:()=>1,cancel:()=>{}});",
    context,
  );
  expect(
    await runInContext("captureWatch.start({intervalSeconds:2,queueMode:'paged'})", context),
  ).toBe(true);
  expect(runInContext("captureWatch.isBusy()", context)).toBe(false);
  await runInContext("captureWatch.stop()", context);
  expect(close).toHaveBeenCalledTimes(1);
  expect(runInContext("captureWatch.isBusy()", context)).toBe(false);
});

it("a departed collection cannot reconnect after launcher protection resolves", async () => {
  const { context, launcher } = controllerFixture();
  const protection = deferred<void>();
  launcher.mockImplementationOnce(() => protection.promise);
  runInContext(
    "captureWatch={start:()=>{throw new Error('stale start')},isActive:()=>false,isBusy:()=>false};",
    context,
  );
  const pending = runInContext("reconnectCaptureWatch()", context) as Promise<void>;
  runInContext("captureReconnectGeneration++;window.location.pathname='/training';", context);
  protection.resolve();
  await pending;
  expect(launcher.mock.calls).toEqual([
    ["collector", true],
    ["collector", false],
  ]);
});

it("a cancelled reconnect cannot release a newer collector recording claim", async () => {
  const { context, launcher } = controllerFixture();
  const protection = deferred<void>();
  launcher.mockImplementationOnce(() => protection.promise);
  runInContext("captureWatch={start:()=>false};", context);
  const pending = runInContext("reconnectCaptureWatch()", context) as Promise<void>;
  runInContext("captureReconnectGeneration++;collectorProtectionGeneration++;", context);
  protection.resolve();
  await pending;
  expect(launcher.mock.calls).toEqual([["collector", true]]);
});

function installPendingWatch(context: ReturnType<typeof createContext>) {
  runInContext(watch, context);
  runInContext(
    "captureWatch=window.CollectorWatchCapture.create({getContext:captureContext,canRun:canWatchCapture,onStatus:rememberCaptureWatch,scan:()=>{throw new Error('stale tick')},close:()=>{throw new Error('unattached lease')},schedule:()=>1,cancel:()=>{}});",
    context,
  );
}

it("explicit Stop revokes the saved lease before a pending protection request finishes", async () => {
  const { context, launcher, api, storage } = controllerFixture();
  const protection = deferred<void>();
  launcher.mockImplementationOnce(() => protection.promise);
  installPendingWatch(context);
  const pending = runInContext("reconnectCaptureWatch()", context) as Promise<void>;
  await runInContext("stopCaptureWatch('Collection paused')", context);
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0]![0]).toBe("/api/watch/stop");
  expect(api.mock.calls[0]![1]).toMatchObject({
    datasetId: "one",
    body: JSON.stringify({ lease_id: "saved-lease" }),
  });
  expect(storage.getItem()).toBeNull();
  expect(launcher.mock.calls).toEqual([["collector", true]]);
  runInContext("window.location.pathname='/training'", context);
  protection.resolve();
  await pending;
  await vi.waitFor(() => {
    expect(launcher.mock.calls).toEqual([
      ["collector", true],
      ["collector", false],
    ]);
  });
  expect(api).toHaveBeenCalledTimes(1);
  expect(runInContext("captureWatch.isActive()", context)).toBe(false);
});

it("failed pending-lease Stop retains its reconnect key and claim until an explicit retry succeeds", async () => {
  const { context, launcher, api, storage } = controllerFixture();
  const protection = deferred<void>();
  launcher.mockImplementationOnce(() => protection.promise);
  api.mockResolvedValueOnce({ ok: false, json: () => ({ lease_id: "saved-lease" }) });
  installPendingWatch(context);
  const pending = runInContext("reconnectCaptureWatch()", context) as Promise<void>;
  await expect(runInContext("stopCaptureWatch('Stopped')", context)).rejects.toThrow("Retry Stop");
  expect(storage.getItem()).toContain("saved-lease");
  protection.resolve();
  await pending;
  expect(api).toHaveBeenCalledTimes(1);
  expect(launcher.mock.calls).toEqual([["collector", true]]);
  await runInContext("stopCaptureWatch('Stopped')", context);
  await vi.waitFor(() => {
    expect(launcher.mock.calls).toEqual([
      ["collector", true],
      ["collector", false],
    ]);
  });
  expect(storage.getItem()).toBeNull();
  expect(api).toHaveBeenCalledTimes(2);
});

it("pending-lease cleanup cannot close a newer lease, erase its key, or release its claim", async () => {
  const { context, launcher, api, storage } = controllerFixture();
  const protection = deferred<void>();
  const closing = deferred<{ ok: boolean; json: () => { lease_id: string } }>();
  launcher.mockImplementationOnce(() => protection.promise);
  api.mockImplementationOnce(() => closing.promise);
  installPendingWatch(context);
  const pending = runInContext("reconnectCaptureWatch()", context) as Promise<void>;
  const stopping = runInContext("stopCaptureWatch('Stopped')", context) as Promise<void>;
  storage.setItem(
    "poker:collection-recording",
    JSON.stringify({ lease: "newer-lease", datasetId: "other" }),
  );
  await runInContext(
    "collectorProtectionGeneration++;window.pokerSetLauncherRecording('collector',true)",
    context,
  );
  closing.resolve({ ok: true, json: () => ({ lease_id: "saved-lease" }) });
  await stopping;
  protection.resolve();
  await pending;
  expect(api).toHaveBeenCalledTimes(1);
  expect(api.mock.calls[0]![1]).toMatchObject({
    datasetId: "one",
    body: JSON.stringify({ lease_id: "saved-lease" }),
  });
  expect(storage.getItem()).toContain("newer-lease");
  expect(launcher.mock.calls).toEqual([
    ["collector", true],
    ["collector", true],
  ]);
});

for (const malformed of [false, true]) {
  it(`failed watch opens release protection while preserving the ${malformed ? "missing lease" : "request"} error`, async () => {
    const { context, launcher, api } = controllerFixture();
    if (malformed) api.mockResolvedValue({ json: () => ({}) } as never);
    else api.mockRejectedValue(new Error("start failed"));
    runInContext(
      "window.CollectorWatchCapture={create:options=>{globalThis.options=options;return {}}};initCaptureWatch();",
      context,
    );
    await expect(
      runInContext(
        "options.open({intervalSeconds:2},{datasetId:'one',epoch:0,monitor:'screen'})",
        context,
      ),
    ).rejects.toThrow(malformed ? "Watch lease was not created" : "start failed");
    expect(launcher.mock.calls).toEqual([
      ["collector", true],
      ["collector", false],
    ]);
  });
}

it("a lease opened after detach is closed instead of becoming an orphan", async () => {
  const opening = deferred<{ lease_id: string }>();
  const close = vi.fn(() => Promise.resolve());
  const context = createContext({ window: {}, open: () => opening.promise, close });
  runInContext(watch, context);
  runInContext(
    "globalThis.controller=window.CollectorWatchCapture.create({getContext:()=>({}),canRun:()=>true,open,close});",
    context,
  );
  const pending = runInContext(
    "controller.start({intervalSeconds:2})",
    context,
  ) as Promise<boolean>;
  await Promise.resolve();
  runInContext("controller.detach()", context);
  opening.resolve({ lease_id: "unattached" });
  expect(await pending).toBe(false);
  expect(close).toHaveBeenCalledWith("unattached", expect.any(Object));
});

it("detach also cancels a start waiting for the prior lease close", async () => {
  const closing = deferred<void>();
  const open = vi.fn(() => Promise.resolve({ lease_id: "lease" }));
  const context = createContext({ window: {}, open, close: () => closing.promise });
  runInContext(watch, context);
  runInContext(
    "globalThis.controller=window.CollectorWatchCapture.create({getContext:()=>({}),canRun:()=>true,open,close,scan:async()=>({added_count:0}),schedule:()=>1,cancel:()=>{}});",
    context,
  );
  expect(await runInContext("controller.start({intervalSeconds:2})", context)).toBe(true);
  runInContext("controller.stop()", context);
  const pending = runInContext(
    "controller.start({intervalSeconds:2})",
    context,
  ) as Promise<boolean>;
  runInContext("controller.detach()", context);
  closing.resolve();
  expect(await pending).toBe(false);
  expect(open).toHaveBeenCalledTimes(1);
});

it("an older OpenAI config read cannot overwrite newer saved settings or errors", async () => {
  const ai = readFileSync("public/static/js/lib/ai_review.js", "utf8");
  const reads = [deferred<object>(), deferred<object>(), deferred<object>(), deferred<object>()];
  let index = 0;
  const context = createContext({
    fetch: () => reads[index++]!.promise,
    aiReviewMatches: () => true,
    paintAiReview: vi.fn(),
  });
  runInContext(
    ai.slice(
      ai.indexOf("async function loadAiReviewConfig"),
      ai.indexOf("async function applyAiReviewJob"),
    ),
    context,
  );
  runInContext("globalThis.state={controller:{signal:{}}};", context);
  const old = runInContext("loadAiReviewConfig(state)", context) as Promise<void>;
  const newer = runInContext("loadAiReviewConfig(state)", context) as Promise<void>;
  reads[1]!.resolve({ ok: true, json: () => Promise.resolve({ configured: true, model: "new" }) });
  await newer;
  reads[0]!.resolve({ ok: true, json: () => Promise.resolve({ configured: false, model: "old" }) });
  await old;
  expect(runInContext("state.config.model", context)).toBe("new");
  expect(runInContext("state.configError", context)).toBe("");
  const stale = runInContext("loadAiReviewConfig(state)", context) as Promise<void>;
  const last = runInContext("loadAiReviewConfig(state)", context) as Promise<void>;
  reads[3]!.resolve({
    ok: true,
    json: () => Promise.resolve({ configured: true, model: "latest" }),
  });
  await last;
  reads[2]!.resolve({ ok: false, json: () => Promise.resolve({ error: "stale error" }) });
  await stale;
  expect(runInContext("state.config.model", context)).toBe("latest");
  expect(runInContext("state.configError", context)).toBe("");
});
