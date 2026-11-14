import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  chooseWorktree,
  activateExistingWindow,
  captureWindowPlacement,
  restoreWindowPlacement,
  discoverWorktrees,
  launcherPaths,
  launcherStatus,
  selectWorktree,
  sourceFingerprint,
  nativeFingerprint,
  nativeBinaryFingerprint,
  nativeEnvironment,
  seedNativeCache,
  readNativeCache,
  stopChild,
  setRecordingIntent,
  recordingActive,
  supervise,
  type Worktree,
} from "../scripts/launch.js";

const temporary: string[] = [];
function stampedFixture(tree: Worktree, path: string, contents = "fixture executable") {
  writeFileSync(
    path,
    `${contents}\nPOKER_LAB_NATIVE_SOURCE_FP:v1:${nativeFingerprint(tree)}:END\n`,
  );
}
it("rejects unverified or stale seeds and copied wrong binaries even when manifest hashes match", () => {
  const { common, repo, paths } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  mkdirSync(paths.cache, { recursive: true });
  const binary = join(paths.cache, "fixture-native");
  writeFileSync(binary, "old binary without provenance");
  expect(() => seedNativeCache(tree, binary, paths)).toThrow("provenance");
  writeFileSync(binary, "POKER_LAB_NATIVE_SOURCE_FP:v1:unverified:END");
  expect(() => seedNativeCache(tree, binary, paths)).toThrow("provenance");
  stampedFixture(tree, binary);
  const cached = seedNativeCache(tree, binary, paths);
  expect(nativeBinaryFingerprint(readFileSync(cached.binary))).toBe(cached.fingerprint);
  const wrong = Buffer.from(
    `wrong executable\nPOKER_LAB_NATIVE_SOURCE_FP:v1:${"e".repeat(64)}:END`,
  );
  writeFileSync(binary, wrong);
  expect(() => seedNativeCache(tree, binary, paths)).toThrow("provenance");
  expect(readNativeCache(tree, paths)).toEqual(cached);
  writeFileSync(cached.binary, wrong);
  const manifest = join(dirname(dirname(cached.binary)), "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ ...cached, sha256: createHash("sha256").update(wrong).digest("hex") }),
  );
  expect(readNativeCache(tree, paths)).toBeNull();
  const previous = nativeFingerprint(tree);
  stampedFixture(tree, binary);
  mkdirSync(join(repo, "apps/poker/src-tauri/src"));
  writeFileSync(join(repo, "apps/poker/src-tauri/src/main.rs"), "changed source");
  expect(() => seedNativeCache(tree, binary, paths, previous)).toThrow("provenance");
});
beforeEach(() => {
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE", "");
});
it("uses Hyprland's explicit disable action so repeated tiled restores cannot toggle floating", async () => {
  for (const initial of [false, true]) {
    let floating = initial;
    const client = () => ({
      class: "unimatrix-poker",
      pid: 20,
      address: "0xabc",
      workspace: { id: 7, name: "7" },
      monitor: 2,
      floating,
      at: [0, 0],
      size: [1920, 1080],
      fullscreen: 0,
      fullscreenClient: 0,
    });
    const command = vi.fn((_command: string, args: string[]) => {
      if (args[1] === "clients") return JSON.stringify([client()]);
      if (args[1] === "activewindow") return '{"address":"0x999"}';
      if (args[0] === "dispatch") return "error: use Lua";
      if (args[0] === "eval" && args[1]?.includes("hl.dsp.window.float(")) {
        const action = /action = "([^"]+)"/.exec(args[1])?.[1];
        floating =
          action === "enable" || action === "on"
            ? true
            : action === "disable" || action === "off"
              ? false
              : !floating;
      }
      return "ok";
    });
    const hooks = {
      platform: "linux",
      env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
      command,
      parentPid: () => 1,
    };
    await restoreWindowPlacement(20, null, hooks);
    expect(floating).toBe(false);
    const placement = { ...captureWindowPlacement(20, hooks)!, floating: false };
    await restoreWindowPlacement(20, placement, hooks);
    expect(floating).toBe(false);
    await restoreWindowPlacement(20, placement, hooks);
    expect(floating).toBe(false);
  }
});
it("restores only the replacement child window silently using the supported Lua fallback", async () => {
  const original = {
    class: "unimatrix-poker",
    pid: 20,
    address: "0xabc",
    workspace: { id: 7, name: "7" },
    monitor: 2,
    floating: true,
    at: [-1200, 80],
    size: [1000, 700],
    fullscreen: 0,
    fullscreenClient: 0,
  };
  let clients = [original, { ...original, pid: 99, address: "0xdef" }];
  let focused = "0x111";
  const command = vi.fn((_command: string, args: string[]) => {
    if (args[1] === "clients") return JSON.stringify(clients);
    if (args[1] === "activewindow") return JSON.stringify({ address: focused });
    if (args[0] === "dispatch") return "error: legacy dispatchers disabled";
    if (args[0] === "eval") {
      if (args[1]?.includes("hl.dsp.focus(")) focused = "0x111";
      return "ok";
    }
    throw new Error("Unexpected command");
  });
  const hooks = {
    platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    command,
    parentPid: (pid: number) => (pid === 20 ? 10 : pid === 30 ? 11 : 1),
    wait: () => Promise.resolve(),
  };
  const placement = captureWindowPlacement(10, hooks)!;
  expect(placement).toMatchObject({
    workspace: "7",
    monitor: 2,
    at: [-1200, 80],
    size: [1000, 700],
    focusAddress: "0x111",
  });
  clients = [{ ...original, pid: 30, address: "0x123" }, clients[1]!];
  focused = "0x123";
  await restoreWindowPlacement(11, placement, hooks);
  const scripts = command.mock.calls
    .filter(([, args]) => args[0] === "eval")
    .map(([, args]) => args[1]!);
  expect(
    scripts.some((script) =>
      script.includes('workspace = "7", follow = false, window = "address:0x123"'),
    ),
  ).toBe(true);
  expect(scripts.some((script) => script.includes("x = -1200, y = 80"))).toBe(true);
  expect(scripts.some((script) => script.includes("x = 1000, y = 700"))).toBe(true);
  expect(scripts.some((script) => script.includes("0xdef"))).toBe(false);
  expect(scripts.some((script) => script.includes('hl.dsp.focus({ window = "address:0x123"'))).toBe(
    false,
  );
  expect(focused).toBe("0x111");
});
it("leaves focus alone when the user has already focused another window and restores tiled/fullscreen state", async () => {
  const client = {
    class: "unimatrix-poker",
    pid: 20,
    address: "0xabc",
    workspace: { id: 7, name: "7" },
    monitor: 2,
    floating: false,
    at: [0, 0],
    size: [1920, 1080],
    fullscreen: 2,
    fullscreenClient: 2,
  };
  const command = vi.fn((_command: string, args: string[]) => {
    if (args[1] === "clients") return JSON.stringify([client]);
    if (args[1] === "activewindow") return '{"address":"0x999"}';
    return "ok";
  });
  const hooks = {
    platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    command,
    parentPid: () => 1,
  };
  const placement = captureWindowPlacement(20, hooks)!;
  await restoreWindowPlacement(20, placement, hooks);
  expect(
    command.mock.calls.some(([, args]) =>
      args[1]?.includes("fullscreen_state({ internal = 2, client = 2"),
    ),
  ).toBe(true);
  expect(
    command.mock.calls.some(([, args]) =>
      args.some((arg) => arg.includes("focuswindow") || arg.includes("hl.dsp.focus(")),
    ),
  ).toBe(false);
  expect(
    command.mock.calls.some(([, args]) => args.some((arg) => arg.includes("resizewindowpixel"))),
  ).toBe(false);
});
it("does not run desktop commands on unsupported desktops or target ambiguous/unowned windows", async () => {
  const command = vi.fn();
  expect(captureWindowPlacement(10, { platform: "win32", command })).toBeNull();
  await restoreWindowPlacement(10, null, { command });
  expect(command).not.toHaveBeenCalled();
  const hooks = {
    platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    parentPid: () => 1,
    command: () => JSON.stringify([{ class: "unimatrix-poker", pid: 99, address: "0xdef" }]),
  };
  expect(() => captureWindowPlacement(10, hooks)).toThrow("owned Poker Lab window");
});
it("focuses only the Poker window descended from the existing launcher and reads focus back", () => {
  const command = vi.fn((_command: string, args: string[]) => {
    if (args[1] === "clients")
      return JSON.stringify([
        { class: "unimatrix-poker", pid: 30, address: "0xabc" },
        { class: "unimatrix-poker", pid: 40, address: "0xdef" },
        { class: "kitty", pid: 20, address: "0x123" },
      ]);
    if (args[1] === "activewindow") return JSON.stringify({ address: "0xabc" });
    return "ok";
  });
  activateExistingWindow(10, {
    platform: "linux",
    env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    parentPid: (pid) =>
      new Map([
        [30, 20],
        [20, 10],
        [40, 1],
      ]).get(pid) ?? 0,
    command,
  });
  expect(command.mock.calls).toEqual([
    ["hyprctl", ["-j", "clients"]],
    ["hyprctl", ["dispatch", "focuswindow", "address:0xabc"]],
    ["hyprctl", ["-j", "activewindow"]],
  ]);
});
it.each([
  ["unsupported desktop", {}, "[]", "{}"],
  ["missing window", { HYPRLAND_INSTANCE_SIGNATURE: "fixture" }, "[]", "{}"],
  [
    "unowned window",
    { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    '[{"class":"unimatrix-poker","pid":40,"address":"0xabc"}]',
    "{}",
  ],
  ["malformed response", { HYPRLAND_INSTANCE_SIGNATURE: "fixture" }, "null", "{}"],
  [
    "ambiguous windows",
    { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    '[{"class":"unimatrix-poker","pid":20,"address":"0xabc"},{"class":"unimatrix-poker","pid":20,"address":"0xdef"}]',
    "{}",
  ],
  [
    "focus refusal",
    { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
    '[{"class":"unimatrix-poker","pid":20,"address":"0xabc"}]',
    '{"address":"0xdef"}',
  ],
])("reports an actionable error for %s", (_name, env, clients, active) => {
  expect(() => {
    activateExistingWindow(10, {
      platform: "linux",
      env,
      parentPid: (pid) => (pid === 20 ? 10 : 0),
      command: (_command, args) => (args[1] === "clients" ? clients : active),
    });
  }).toThrow("Open its existing workspace/window");
});
it("reports missing desktop commands instead of silently accepting a duplicate shortcut", () => {
  expect(() => {
    activateExistingWindow(10, {
      platform: "linux",
      env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
      command: () => {
        throw new Error("spawnSync hyprctl ENOENT");
      },
    });
  }).toThrow("Open its existing workspace/window. Error: spawnSync hyprctl ENOENT");
});
it.each(["exit failure", "error reply"])(
  "uses the Lua focus dispatcher after legacy %s",
  (failure) => {
    const command = vi.fn((_command: string, args: string[]) => {
      if (args[1] === "clients") return '[{"class":"unimatrix-poker","pid":20,"address":"0xabc"}]';
      if (args[0] === "dispatch") {
        if (failure === "exit failure") throw new Error("dispatch in lua is a shorthand");
        return "error: dispatch in lua is a shorthand";
      }
      if (args[1] === "activewindow") return '{"address":"0xabc"}';
      return "ok";
    });
    activateExistingWindow(10, {
      platform: "linux",
      env: { HYPRLAND_INSTANCE_SIGNATURE: "fixture" },
      parentPid: () => 10,
      command,
    });
    expect(command).toHaveBeenCalledWith("hyprctl", [
      "eval",
      'hl.dispatch(hl.dsp.focus({ window = "address:0xabc" }))',
    ]);
  },
);
it("silently leaves an existing native build running when the shortcut is pressed again", async () => {
  const { common, repo, paths } = fixture();
  mkdirSync(paths.lock, { recursive: true });
  writeFileSync(join(paths.lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  const state = {
    pid: process.pid,
    current: null,
    error: "Building the native development app for this worktree",
  };
  writeFileSync(paths.state, JSON.stringify(state));
  const activate = vi.fn(),
    notify = vi.fn(),
    build = vi.fn(),
    launch = vi.fn();
  await supervise(common, repo, paths, { activate, notify, build, launch });
  expect(notify).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(paths.state, "utf8"))).toEqual(state);
});
it("a repeated shortcut activates without taking the lock, changing selection or launching anything", async () => {
  const { common, repo, other, paths } = fixture();
  selectWorktree(common, repo, other, paths);
  mkdirSync(paths.lock, { recursive: true });
  writeFileSync(join(paths.lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  writeFileSync(paths.state, JSON.stringify({ pid: process.pid, current: { path: repo } }));
  const before = [paths.preference, paths.state, join(paths.lock, "owner.json")].map((path) =>
    readFileSync(path, "utf8"),
  );
  const activate = vi.fn();
  const launch = vi.fn();
  const build = vi.fn();
  const startServer = vi.fn();
  await supervise(common, repo, paths, { activate, launch, build, startServer });
  expect(activate).toHaveBeenCalledExactlyOnceWith(process.pid);
  expect(launch).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
  expect(startServer).not.toHaveBeenCalled();
  expect(
    [paths.preference, paths.state, join(paths.lock, "owner.json")].map((path) =>
      readFileSync(path, "utf8"),
    ),
  ).toEqual(before);
  await expect(
    supervise(common, repo, paths, {
      activate: () => {
        throw new Error("activation unavailable");
      },
      launch,
      build,
      startServer,
    }),
  ).rejects.toThrow("activation unavailable");
  expect(readFileSync(join(paths.lock, "owner.json"), "utf8")).toBe(before[2]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
it("preserves staged originals when an ELF cannot be stripped or the optional tool is missing", () => {
  const { common, repo, paths } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  const fingerprint = nativeFingerprint(tree);
  mkdirSync(paths.cache, { recursive: true });
  const binary = join(paths.cache, "invalid-elf-fixture");
  const bytes = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(`safe dummy fixture\nPOKER_LAB_NATIVE_SOURCE_FP:v1:${fingerprint}:END`),
  ]);
  writeFileSync(binary, bytes);
  const invalid = seedNativeCache(tree, binary, paths, fingerprint);
  expect(readFileSync(invalid.binary)).toEqual(bytes);
  const commands = join(paths.cache, "git-only");
  mkdirSync(commands);
  symlinkSync("/usr/bin/git", join(commands, "git"));
  vi.stubEnv("PATH", commands);
  const missing = seedNativeCache(tree, binary, paths, fingerprint);
  expect(readFileSync(missing.binary)).toEqual(bytes);
  expect(readNativeCache(tree, paths)).toEqual(missing);
  expect(readFileSync(binary)).toEqual(bytes);
});
it("native fingerprints ignore UI, fonts, tests, docs, model helpers and Git HEAD but detect Rust edits", () => {
  const { common, repo } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  const before = nativeFingerprint(tree);
  for (const file of [
    "apps/poker/src/view.tsx",
    "packages/ui/src/fonts/font.woff2",
    "apps/poker/test/example.test.ts",
    "apps/poker/README.md",
    "tools/poker/worker.py",
  ]) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), "changed UI/runtime helper");
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", "frontend-only");
  expect(nativeFingerprint({ ...tree, head: git(repo, "rev-parse", "HEAD") })).toBe(before);
  mkdirSync(join(repo, "apps/poker/src-tauri/src"));
  writeFileSync(join(repo, "apps/poker/src-tauri/src/main.rs"), "fn main() {}");
  expect(nativeFingerprint(tree)).not.toBe(before);
});
it("invalidates native artifacts when the embedded OCR contract changes", () => {
  const { common, repo } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  const contract = join(repo, "packages/poker/ocr-contract.json");
  mkdirSync(join(repo, "packages/poker"), { recursive: true });
  writeFileSync(contract, JSON.stringify({ version: 1 }));
  git(repo, "add", ".");
  git(repo, "commit", "-m", "contract baseline");
  const original = nativeFingerprint(tree);
  writeFileSync(contract, JSON.stringify({ version: 2 }));
  const changed = nativeFingerprint(tree);
  expect(changed).not.toBe(original);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "contract update");
  expect(nativeFingerprint({ ...tree, head: git(repo, "rev-parse", "HEAD") })).toBe(changed);
});
function fakeProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}
it.each(["rebuild", "checkout", "checkout-build", "rebuild-placement-failure"])(
  "defers %s until every recording source explicitly stops",
  async (mode) => {
    const rebuild = mode.startsWith("rebuild");
    const { common, repo, other, paths } = fixture();
    const trees = discoverWorktrees(common);
    const tree = trees.find((item) => item.path === repo)!;
    mkdirSync(paths.cache, { recursive: true });
    const binary = join(paths.cache, "fixture-native");
    stampedFixture(tree, binary, "verified build");
    seedNativeCache(tree, binary, paths);
    if (mode !== "checkout-build")
      seedNativeCache(
        trees.find((item) => item.path === other)!,
        binary,
        paths,
      );
    const apps: ChildProcess[] = [];
    const launch = vi.fn(() => {
      const app = fakeProcess();
      apps.push(app);
      return app;
    });
    const servers: ChildProcess[] = [];
    const startServer = vi.fn(() => {
      const child = fakeProcess();
      servers.push(child);
      return Promise.resolve({ child });
    });
    const build = vi.fn((selected: Worktree) => {
      if (mode === "checkout-build") {
        setRecordingIntent(apps[0]!.pid!, "gameplay", true, paths);
        setRecordingIntent(apps[0]!.pid!, "collector", true, paths);
      }
      stampedFixture(selected, binary);
      return Promise.resolve(seedNativeCache(selected, binary, paths));
    });
    const placement = {
      workspace: "7",
      monitor: 2,
      floating: true,
      at: [0, 0] as [number, number],
      size: [1920, 1080] as [number, number],
      fullscreen: 0,
      fullscreenClient: 0,
      focusAddress: null,
    };
    const capturePlacement = vi.fn(() => {
      if (mode === "rebuild-placement-failure" && capturePlacement.mock.calls.length === 1)
        throw new Error("Window placement temporarily unavailable");
      return placement;
    });
    const restorePlacement = vi.fn(() => Promise.resolve());
    let ticks = 0;
    await supervise(common, repo, paths, {
      build,
      launch,
      capturePlacement,
      restorePlacement,
      startServer,
      stopServer: async ({ child }) => {
        await stopChild(child);
      },
      shouldStop: () => ticks >= (mode === "rebuild-placement-failure" ? 9 : 7),
      pause: async () => {
        ticks++;
        const original = apps[0]!;
        if (ticks === 1) {
          if (mode !== "checkout-build") {
            setRecordingIntent(original.pid!, "gameplay", true, paths);
            setRecordingIntent(original.pid!, "collector", true, paths);
          }
          if (!rebuild) selectWorktree(common, repo, other, paths);
          else {
            mkdirSync(join(repo, "apps/poker/src-tauri/src"));
            writeFileSync(join(repo, "apps/poker/src-tauri/src/main.rs"), "changed Rust");
          }
        }
        if (ticks >= 3 && ticks <= 5) {
          expect(launch).toHaveBeenCalledTimes(1);
          expect(original.exitCode).toBeNull();
          expect(servers[0]!.exitCode).toBeNull();
          expect(recordingActive(original.pid!, paths)).toBe(true);
        }
        if (ticks === 4) setRecordingIntent(original.pid!, "gameplay", false, paths);
        if (ticks === 5) setRecordingIntent(original.pid!, "collector", false, paths);
        await new Promise((done) => setTimeout(done, 20));
      },
    });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledTimes(mode === "checkout" ? 0 : 1);
    expect(startServer).toHaveBeenCalledTimes(rebuild ? 1 : 2);
    expect(capturePlacement).toHaveBeenCalledTimes(mode === "rebuild-placement-failure" ? 2 : 1);
    expect(capturePlacement).toHaveBeenCalledWith(apps[0]!.pid);
    expect(restorePlacement).toHaveBeenCalledTimes(2);
    expect(restorePlacement).toHaveBeenNthCalledWith(1, apps[0]!.pid, null);
    expect(restorePlacement).toHaveBeenNthCalledWith(2, apps[1]!.pid, {
      ...placement,
      floating: false,
    });
    expect(existsSync(join(paths.cache, "recording", `${apps[0]!.pid}-gameplay.json`))).toBe(false);
  },
);
it("ignores stale process-start recording claims", () => {
  const { paths } = fixture();
  setRecordingIntent(process.pid, "collector", true, paths);
  expect(recordingActive(process.pid, paths)).toBe(true);
  writeFileSync(join(paths.cache, "recording", `${process.pid}-collector.json`), '{"token":"old"}');
  expect(recordingActive(process.pid, paths)).toBe(false);
});
it.skipIf(process.platform !== "linux")(
  "fingerprints ignore a replaced FIFO without blocking and track deleted files",
  () => {
    const { common, repo } = fixture();
    const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
    const file = join(repo, "apps/poker/src-tauri/build.rs");
    writeFileSync(file, "fn main() {}\n");
    git(repo, "add", ".");
    const original = [sourceFingerprint(tree), nativeFingerprint(tree)];
    rmSync(file);
    const deleted = [sourceFingerprint(tree), nativeFingerprint(tree)];
    expect(deleted[0]).not.toBe(original[0]);
    expect(deleted[1]).not.toBe(original[1]);
    const result = spawnSync("mkfifo", [file], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.error?.message || result.stderr);
    expect(sourceFingerprint(tree)).not.toBe(deleted[0]);
    expect(nativeFingerprint(tree)).not.toBe(deleted[1]);
    rmSync(file);
    writeFileSync(file, "fn main() {}\n");
    expect([sourceFingerprint(tree), nativeFingerprint(tree)]).toEqual(original);
  },
);
it("starts from persistent verified cache without a build and keeps the native PID for UI edits until manual close", async () => {
  const { common, repo, paths } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  const binary = join(paths.cache, "fixture-native");
  mkdirSync(paths.cache, { recursive: true });
  stampedFixture(tree, binary);
  const cached = seedNativeCache(tree, binary, paths);
  const build = vi.fn(() => Promise.reject(new Error("Unexpected Cargo build")));
  const apps: ChildProcess[] = [];
  const launch = vi.fn(() => {
    const app = fakeProcess();
    apps.push(app);
    return app;
  });
  const serverProcess = fakeProcess();
  const startServer = vi.fn(() => Promise.resolve({ child: serverProcess }));
  const stopServer = vi.fn(async () => {
    await stopChild(serverProcess);
  });
  let ticks = 0;
  await supervise(common, repo, paths, {
    build,
    launch,
    startServer,
    stopServer,
    shouldStop: () => ticks > 8,
    pause: async () => {
      ticks++;
      if (ticks === 1) writeFileSync(join(repo, "apps/poker/view.tsx"), "UI edit");
      if (ticks === 2) {
        mkdirSync(join(repo, "packages/ui/src/fonts"), { recursive: true });
        writeFileSync(join(repo, "packages/ui/src/fonts/changed.woff2"), "font edit");
      }
      if (ticks === 3) writeFileSync(join(repo, "apps/poker/README.md"), "documentation edit");
      if (ticks === 4) {
        expect(launch).toHaveBeenCalledTimes(1);
        expect(build).not.toHaveBeenCalled();
        const app = apps[0]!;
        expect(app.exitCode).toBeNull();
        app.kill("SIGTERM");
      }
      await new Promise((done) => setTimeout(done, 20));
    },
  });
  expect(ticks).toBeLessThan(7);
  expect(build).not.toHaveBeenCalled();
  expect(startServer).toHaveBeenCalledTimes(1);
  expect(stopServer).toHaveBeenCalledTimes(1);
  expect(readNativeCache(tree, paths)).toEqual(cached);
  expect(existsSync(cached.binary)).toBe(true);
  expect(serverProcess.exitCode !== null || serverProcess.signalCode !== null).toBe(true);
  expect(nativeEnvironment(tree, common).POKER_LAB_BUNDLED).toBeUndefined();
});
it("keeps the cached native process and owned Vite server when a background Rust rebuild fails", async () => {
  const { common, repo, paths } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  mkdirSync(paths.cache, { recursive: true });
  const binary = join(paths.cache, "fixture-native");
  stampedFixture(tree, binary, "verified old build");
  const cached = seedNativeCache(tree, binary, paths);
  const build = vi.fn(() => Promise.reject(new Error("Rust compile failed")));
  const apps: ChildProcess[] = [];
  const launch = vi.fn(() => {
    const app = fakeProcess();
    apps.push(app);
    return app;
  });
  const serverProcess = fakeProcess();
  const startServer = vi.fn(() => Promise.resolve({ child: serverProcess }));
  let ticks = 0;
  await supervise(common, repo, paths, {
    build,
    launch,
    startServer,
    stopServer: async () => {
      await stopChild(serverProcess);
    },
    shouldStop: () => ticks >= 5,
    pause: async () => {
      ticks++;
      if (ticks === 1) {
        mkdirSync(join(repo, "apps/poker/src-tauri/src"));
        writeFileSync(join(repo, "apps/poker/src-tauri/src/main.rs"), "changed Rust");
      }
      if (ticks >= 4) {
        expect(JSON.parse(readFileSync(paths.state, "utf8"))).toMatchObject({
          current: { path: repo },
          error: "Error: Rust compile failed",
        });
        expect(apps[0]!.exitCode).toBeNull();
      }
      await new Promise((done) => setTimeout(done, 20));
    },
  });
  expect(build).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledTimes(1);
  expect(startServer).toHaveBeenCalledTimes(1);
  expect(readNativeCache(tree, paths)).toBeNull();
  writeFileSync(cached.binary, "tampered", { flag: "r+" });
  expect(readNativeCache(tree, paths)).toBeNull();
});
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "poker-launcher-"));
  temporary.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(repo, "apps/poker/src-tauri"), { recursive: true });
  writeFileSync(join(repo, "apps/poker/package.json"), "{}");
  writeFileSync(join(repo, "apps/poker/src-tauri/Cargo.toml"), "[package]\nname='fixture'\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  const other = join(root, "other checkout");
  git(repo, "worktree", "add", "-b", "work/other", other);
  const paths = launcherPaths({
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
  });
  return { repo, other, common: join(repo, ".git"), paths };
}
it("discovers active eligible worktrees, selects latest deterministically and fingerprints uncommitted changes", () => {
  const { common, repo, other } = fixture();
  const trees = discoverWorktrees(common);
  expect(trees).toHaveLength(2);
  expect(chooseWorktree(common, trees, "latest", other).path).toBe(other);
  expect(chooseWorktree(common, trees, repo, other).path).toBe(repo);
  const selected = trees.find((tree) => tree.path === other)!;
  const before = sourceFingerprint(selected);
  writeFileSync(join(other, "apps/poker/unsaved.ts"), "export const draft = 1;");
  expect(sourceFingerprint(selected)).not.toBe(before);
  mkdirSync(join(other, "tools/poker"), { recursive: true });
  writeFileSync(join(other, "tools/poker/worker.py"), "version = 1");
  const withWorker = sourceFingerprint(selected);
  writeFileSync(join(other, "tools/poker/worker.py"), "version = 2");
  expect(sourceFingerprint(selected)).not.toBe(withWorker);
  const withUpdatedWorker = sourceFingerprint(selected);
  writeFileSync(join(other, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
  expect(sourceFingerprint(selected)).not.toBe(withUpdatedWorker);
  mkdirSync(join(other, "apps/poker/dist"));
  writeFileSync(join(other, "apps/poker/dist/generated.js"), "generated");
  const after = sourceFingerprint(selected);
  writeFileSync(join(other, "apps/poker/dist/generated.js"), "changed build output");
  expect(sourceFingerprint(selected)).toBe(after);
  const commit = spawnSync("git", ["-C", other, "commit", "--allow-empty", "-m", "newer commit"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-02-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-02-01T00:00:00Z",
    },
  });
  expect(commit.status).toBe(0);
  expect(chooseWorktree(common, discoverWorktrees(common), "latest", repo).path).toBe(other);
  rmSync(join(other, "apps/poker/src-tauri/Cargo.toml"));
  expect(discoverWorktrees(common)).toHaveLength(1);
});
it("ignores relative XDG roots and preserves the legacy HOME fallbacks", () => {
  expect(
    launcherPaths({
      HOME: "/fixture/home",
      XDG_CONFIG_HOME: "relative",
      XDG_CACHE_HOME: "relative",
    }),
  ).toMatchObject({
    preference: "/fixture/home/.config/poker/launcher.json",
    cache: "/fixture/home/.cache/poker",
  });
});
it("persists only validated selections and reports the actual supervisor checkout separately", () => {
  const { common, repo, other, paths } = fixture();
  expect(launcherStatus(common, repo, paths)).toMatchObject({
    selection: "latest",
    current: null,
    desired: { path: repo },
  });
  expect(selectWorktree(common, repo, other, paths)).toMatchObject({
    selection: other,
    current: null,
    desired: { path: other },
  });
  expect(() => selectWorktree(common, repo, "/not/an/active/worktree", paths)).toThrow(
    "no longer active",
  );
  expect(launcherStatus(common, repo, paths).selection).toBe(other);
  const current = discoverWorktrees(common).find((tree) => tree.path === repo);
  mkdirSync(join(paths.cache), { recursive: true });
  writeFileSync(paths.state, JSON.stringify({ pid: process.pid, current, error: "build failed" }));
  expect(launcherStatus(common, repo, paths)).toMatchObject({
    current: { path: repo },
    desired: { path: other },
    error: "build failed",
  });
  writeFileSync(paths.state, JSON.stringify({ pid: 2147483647, current, error: null }));
  expect(launcherStatus(common, repo, paths).current).toBeNull();
});
