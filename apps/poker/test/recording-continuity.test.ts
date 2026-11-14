import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

it("detaches an in-flight watch without closing its lease and reconnects that same lease", async () => {
  const window: Record<string, unknown> = {};
  vm.runInNewContext(readFileSync("public/static/js/lib/watch_capture.js", "utf8"), { window });
  type Controller = {
    start: (settings: object, lease?: string) => Promise<boolean>;
    detach: () => void;
    stop: () => Promise<void>;
    getState: () => { lease: string };
  };
  const create = (window.CollectorWatchCapture as { create: (options: object) => Controller })
    .create;
  const close = vi.fn();
  const open = vi.fn(() => Promise.resolve({ lease_id: "native-lease" }));
  let finish!: (value: object) => void;
  const scan = vi.fn(
    () =>
      new Promise<object>((resolve) => {
        finish = resolve;
      }),
  );
  const schedule = vi.fn();
  const options = {
    open,
    close,
    scan,
    schedule,
    cancel: vi.fn(),
    getContext: () => ({ datasetId: "d1" }),
    canRun: () => true,
  };
  const original = create(options);
  const pending = original.start({ intervalSeconds: 2 });
  await vi.waitFor(() => {
    expect(scan).toHaveBeenCalledOnce();
  });
  const lease = original.getState().lease;
  original.detach();
  finish({ added_count: 0 });
  await pending;
  expect(close).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
  const reconnected = create({
    ...options,
    scan: vi.fn((value: string) => {
      expect(value).toBe(lease);
      return Promise.resolve({ added_count: 0 });
    }),
  });
  await reconnected.start({ intervalSeconds: 2 }, lease);
  expect(open).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledOnce();
  await reconnected.stop();
  expect(close).toHaveBeenCalledWith("native-lease", { datasetId: "d1" });
});
