import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

export interface Worktree {
  id: string;
  path: string;
  branch: string;
  head: string;
}
interface ActiveState {
  pid: number;
  current: Worktree | null;
  error: string | null;
}
interface LauncherPaths {
  preference: string;
  state: string;
  lock: string;
  cache: string;
}

export function launcherPaths(env: NodeJS.ProcessEnv = process.env): LauncherPaths {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const config = join(
    env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, ".config"),
    "poker",
  );
  const cache = join(
    env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME)
      ? env.XDG_CACHE_HOME
      : join(home, ".cache"),
    "poker",
  );
  return {
    preference: join(config, "launcher.json"),
    state: join(cache, "launcher-state.json"),
    lock: join(cache, "launcher.lock"),
    cache,
  };
}
function git(common: string, args: string[]): string {
  const result = spawnSync("git", ["--git-dir", common, ...args], { encoding: "utf8" });
  if (result.status !== 0 || result.error)
    throw new Error(result.error?.message || result.stderr || "Git command failed");
  return result.stdout;
}
export function discoverWorktrees(common: string): Worktree[] {
  const records: Record<string, string>[] = [];
  let record: Record<string, string> = {};
  for (const field of git(common, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (!field) {
      if (record.worktree) records.push(record);
      record = {};
      continue;
    }
    const split = field.indexOf(" ");
    record[split === -1 ? field : field.slice(0, split)] =
      split === -1 ? "true" : field.slice(split + 1);
  }
  if (record.worktree) records.push(record);
  return records
    .flatMap((entry) => {
      const path = entry.worktree;
      if (
        !path ||
        entry.prunable ||
        entry.bare ||
        !existsSync(join(path, "apps/poker/package.json")) ||
        !existsSync(join(path, "apps/poker/src-tauri/Cargo.toml"))
      )
        return [];
      const canonical = realpathSync(path);
      return [
        {
          id: canonical,
          path: canonical,
          branch:
            entry.branch?.replace(/^refs\/heads\//, "") || `Detached ${entry.HEAD?.slice(0, 8)}`,
          head: entry.HEAD || "",
        },
      ];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
export function chooseWorktree(
  common: string,
  worktrees: Worktree[],
  selection: string,
  preferred: string,
): Worktree {
  if (!worktrees.length) throw new Error("No active Poker Lab worktrees are available");
  if (selection !== "latest") {
    const selected = worktrees.find((item) => item.id === selection);
    if (!selected) throw new Error("The selected Poker Lab worktree is no longer active");
    return selected;
  }
  const ranked = worktrees.map((tree) => ({
    tree,
    time: Number(git(common, ["show", "-s", "--format=%ct", tree.head]).trim()),
  }));
  ranked.sort(
    (a, b) =>
      b.time - a.time ||
      Number(b.tree.path === preferred) - Number(a.tree.path === preferred) ||
      a.tree.path.localeCompare(b.tree.path),
  );
  return ranked[0]!.tree;
}
function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
type RecordingRole = "gameplay" | "collector";
function processToken(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}
function recordingPath(paths: LauncherPaths, pid: number, role: RecordingRole): string {
  return join(paths.cache, "recording", `${pid}-${role}.json`);
}
export function setRecordingIntent(
  pid: number,
  role: RecordingRole,
  active: boolean,
  paths = launcherPaths(),
): void {
  if (!Number.isSafeInteger(pid) || pid < 2 || !["gameplay", "collector"].includes(role))
    throw new Error("Invalid recording intent");
  const path = recordingPath(paths, pid, role);
  if (active) atomicJson(path, { token: processToken(pid) });
  else rmSync(path, { force: true });
}
export function recordingActive(pid: number, paths = launcherPaths()): boolean {
  const token = processToken(pid);
  return (["gameplay", "collector"] as const).some((role) => {
    const claim = readJson(recordingPath(paths, pid, role)) as { token?: unknown } | null;
    return claim?.token === token;
  });
}
function clearRecording(pid: number, paths: LauncherPaths): void {
  for (const role of ["gameplay", "collector"] as const)
    rmSync(recordingPath(paths, pid, role), { force: true });
}
function activeState(paths: LauncherPaths): ActiveState | null {
  const state = readJson(paths.state) as ActiveState | null;
  return state && Number.isInteger(state.pid) && alive(state.pid) ? state : null;
}
function selectionAt(paths: LauncherPaths): string {
  const config = readJson(paths.preference) as { selection?: unknown } | null;
  if (config?.selection !== undefined && typeof config.selection !== "string")
    throw new Error("Invalid launcher preference");
  return config?.selection || "latest";
}
export function launcherStatus(common: string, preferred: string, paths = launcherPaths()) {
  const worktrees = discoverWorktrees(common);
  const selection = selectionAt(paths);
  const active = activeState(paths);
  let desired: Worktree | null = null;
  let error = active?.error || null;
  try {
    desired = chooseWorktree(common, worktrees, selection, preferred);
  } catch (failure) {
    error = String(failure);
  }
  return { selection, current: active?.current || null, desired, worktrees, error };
}
export function selectWorktree(
  common: string,
  preferred: string,
  selection: string,
  paths = launcherPaths(),
) {
  chooseWorktree(common, discoverWorktrees(common), selection, preferred);
  atomicJson(paths.preference, { selection });
  return launcherStatus(common, preferred, paths);
}
function fingerprintFile(path: string): Buffer | null | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  try {
    return fstatSync(descriptor).isFile() ? readFileSync(descriptor) : null;
  } finally {
    closeSync(descriptor);
  }
}
export function sourceFingerprint(tree: Worktree): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      tree.path,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/poker",
      "packages/poker",
      "packages/poker-native",
      "packages/shared",
      "packages/ui",
      "packages/chrome",
      "tools/poker",
      "Cargo.toml",
      "Cargo.lock",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "infra/scripts/pnpm-with-pinned-node.sh",
      "infra/scripts/run-local-workload.mjs",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr);
  const hash = createHash("sha256").update(tree.head);
  for (const path of [...new Set(result.stdout.split("\0"))].sort()) {
    if (
      !path ||
      /(^|\/)(node_modules|dist|target|coverage|\.test-browser-dist|test-results|playwright-report|data)(\/|$)/.test(
        path,
      )
    )
      continue;
    const content = fingerprintFile(join(tree.path, path));
    if (content === undefined) {
      hash.update(`${path}:deleted`);
      continue;
    }
    if (content !== null) hash.update(path).update(content);
  }
  return hash.digest("hex");
}
export function nativeFingerprint(tree: Worktree): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      tree.path,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "Cargo.toml",
      "Cargo.lock",
      "packages/poker-native",
      "packages/poker/ocr-contract.json",
      "apps/poker/src-tauri",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.error) throw new Error(result.error?.message || result.stderr);
  const hash = createHash("sha256");
  for (const path of [...new Set(result.stdout.split("\0"))].sort()) {
    if (
      !path ||
      /(^|\/)(target|gen|tests?|examples|dist)(\/|$)/.test(path) ||
      /\.(md|woff2?|ttf|otf)$/.test(path)
    )
      continue;
    const content = fingerprintFile(join(tree.path, path));
    hash.update(path);
    if (content === undefined) hash.update(":deleted");
    else if (content !== null) hash.update(content);
  }
  return hash.digest("hex");
}
export interface NativeArtifact {
  mode: "vite-dev";
  worktree: string;
  fingerprint: string;
  binary: string;
  sha256: string;
}
export function nativeBinaryFingerprint(bytes: Buffer): string | null {
  const prefix = Buffer.from("POKER_LAB_NATIVE_SOURCE_FP:v1:");
  let offset = 0;
  const found = new Set<string>();
  while ((offset = bytes.indexOf(prefix, offset)) !== -1) {
    offset += prefix.length;
    const value = bytes.subarray(offset, offset + 64).toString("ascii");
    if (
      /^[a-f0-9]{64}$/.test(value) &&
      bytes.subarray(offset + 64, offset + 68).toString("ascii") === ":END"
    )
      found.add(value);
  }
  return found.size === 1 ? [...found][0]! : null;
}
function nativeCacheDirectory(tree: Worktree, paths: LauncherPaths) {
  return join(
    paths.cache,
    "native-dev",
    createHash("sha256").update(tree.id).digest("hex").slice(0, 24),
  );
}
function isElf(path: string): boolean {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(4);
    return (
      readSync(descriptor, header, 0, 4, 0) === 4 &&
      header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    );
  } finally {
    closeSync(descriptor);
  }
}
function stripRuntimeDebugInfo(path: string): void {
  if (process.platform !== "linux" || !isElf(path)) return;
  const stripped = `${path}.stripped`;
  try {
    const result = spawnSync("strip", ["--strip-debug", "-o", stripped, path], {
      encoding: "utf8",
    });
    if (result.status === 0 && existsSync(stripped) && isElf(stripped)) renameSync(stripped, path);
  } catch {
    /* Stripping is optional; retain the complete staged original. */
  } finally {
    rmSync(stripped, { force: true });
  }
}
export function seedNativeCache(
  tree: Worktree,
  binary: string,
  paths = launcherPaths(),
  fingerprint = nativeFingerprint(tree),
): NativeArtifact {
  if (
    fingerprint !== nativeFingerprint(tree) ||
    nativeBinaryFingerprint(readFileSync(binary)) !== fingerprint
  )
    throw new Error(
      "Native binary provenance does not match the current source; rebuild Poker Lab before caching it",
    );
  const directory = nativeCacheDirectory(tree, paths);
  const output = join(directory, randomUUID(), "unimatrix-poker");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(binary, output);
    stripRuntimeDebugInfo(output);
    if (nativeBinaryFingerprint(readFileSync(output)) !== fingerprint)
      throw new Error("Staged native binary lost its verified source fingerprint");
    chmodSync(output, 0o700);
    const artifact: NativeArtifact = {
      mode: "vite-dev",
      worktree: tree.id,
      fingerprint,
      binary: output,
      sha256: createHash("sha256").update(readFileSync(output)).digest("hex"),
    };
    atomicJson(join(directory, "manifest.json"), artifact);
    return artifact;
  } catch (error) {
    rmSync(dirname(output), { recursive: true, force: true });
    throw error;
  }
}
export function readNativeCache(tree: Worktree, paths = launcherPaths()): NativeArtifact | null {
  const directory = nativeCacheDirectory(tree, paths);
  const value = readJson(join(directory, "manifest.json")) as Partial<NativeArtifact> | null;
  if (
    !value ||
    value.mode !== "vite-dev" ||
    value.worktree !== tree.id ||
    typeof value.binary !== "string" ||
    typeof value.fingerprint !== "string" ||
    typeof value.sha256 !== "string" ||
    !value.binary.startsWith(`${directory}/`) ||
    !existsSync(value.binary)
  )
    return null;
  const bytes = readFileSync(value.binary);
  if (
    value.fingerprint !== nativeFingerprint(tree) ||
    nativeBinaryFingerprint(bytes) !== value.fingerprint ||
    createHash("sha256").update(bytes).digest("hex") !== value.sha256
  )
    return null;
  return value as NativeArtifact;
}
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const abort = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* The build process group already exited. */
        }
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      // An interrupted build never publishes a cache manifest.
      if (code === 0) done();
      else reject(new Error(`${basename(command)} failed (${code ?? signal})`));
    });
    child.once("close", () => {
      signal?.removeEventListener("abort", abort);
    });
  });
}
export async function buildNative(
  tree: Worktree,
  paths: LauncherPaths,
  signal?: AbortSignal,
): Promise<NativeArtifact> {
  const fingerprint = nativeFingerprint(tree);
  const target = join(
    resolve(process.env.CARGO_TARGET_DIR || join(paths.cache, "native-target")),
    createHash("sha256").update(tree.id).digest("hex").slice(0, 24),
  );
  await run(
    process.execPath,
    [
      join(tree.path, "infra/scripts/run-local-workload.mjs"),
      "--",
      "cargo",
      "build",
      "--manifest-path",
      join(tree.path, "Cargo.toml"),
      "-p",
      "unimatrix-poker",
      "--no-default-features",
    ],
    tree.path,
    { ...process.env, CARGO_TARGET_DIR: target, POKER_LAB_NATIVE_SOURCE_FP: fingerprint },
    signal,
  );
  if (signal?.aborted) throw new Error("Native build cancelled");
  if (nativeFingerprint(tree) !== fingerprint)
    throw new Error("Native sources changed during build");
  return seedNativeCache(tree, join(target, "debug/unimatrix-poker"), paths, fingerprint);
}
export interface DevServer {
  child: ChildProcess;
}
function portOccupied(host: string): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port: 5180 });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => {
      socket.destroy();
      done(false);
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(true);
    });
  });
}
export async function startViteServer(tree: Worktree): Promise<DevServer> {
  if ((await Promise.all([portOccupied("127.0.0.1"), portOccupied("::1")])).some(Boolean))
    throw new Error(
      "Port 5180 is already occupied; the launcher will not replace an unowned server",
    );
  let stderr = "";
  const spawnFailure: { error: Error | null } = { error: null };
  const child = spawn(
    join(tree.path, "infra/scripts/pnpm-with-pinned-node.sh"),
    [
      "--filter",
      "@unimatrix/poker-app",
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      "5180",
      "--strictPort",
    ],
    { cwd: tree.path, detached: true, stdio: ["ignore", "inherit", "pipe"] },
  );
  child.once("error", (error) => {
    spawnFailure.error = error;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4096);
    process.stderr.write(chunk);
  });
  const server = { child };
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnFailure.error || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Vite could not start: ${spawnFailure.error?.message || stderr}`);
      try {
        const response = await fetch("http://127.0.0.1:5180/@vite/client", {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          await new Promise((done) => setTimeout(done, 150));
          if (child.exitCode === null && child.signalCode === null && !spawnFailure.error)
            return server;
        }
      } catch {
        /* Vite has not bound its port yet. */
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Vite readiness timed out: ${stderr}`);
  } catch (error) {
    await stopViteServer(server);
    throw error;
  }
}
export async function stopViteServer(server: DevServer): Promise<void> {
  const child = server.child;
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The owned Vite process group already exited. */
    }
  }
  await stopChild(child);
}
export function nativeEnvironment(tree: Worktree, common: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POKER_LAB_TOOLS_ROOT: join(tree.path, "tools/poker"),
    POKER_LAB_LAUNCHER_NODE: process.execPath,
    POKER_LAB_LAUNCHER_PATH: fileURLToPath(import.meta.url),
    POKER_LAB_GIT_DIR: common,
    POKER_LAB_LAUNCHER_GIT_DIR: common,
  };
  delete env.POKER_LAB_BUNDLED;
  return env;
}
interface ActivationHooks {
  platform: string;
  env: NodeJS.ProcessEnv;
  command: (command: string, args: string[]) => string;
  parentPid: (pid: number) => number;
}
const activationHooks: ActivationHooks = {
  platform: process.platform,
  env: process.env,
  command: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0)
      throw new Error(
        `${command} failed: ${result.error?.message || result.stderr || result.stdout}`,
      );
    return result.stdout.trim();
  },
  parentPid: (pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return 0;
    }
  },
};
export interface WindowPlacement {
  workspace: string;
  monitor: number;
  floating: boolean;
  at: [number, number];
  size: [number, number];
  fullscreen: number;
  fullscreenClient: number;
  focusAddress: string | null;
}
interface PlacementHooks extends ActivationHooks {
  wait: () => Promise<void>;
}
const placementHooks: PlacementHooks = {
  ...activationHooks,
  wait: () => new Promise((done) => setTimeout(done, 100)),
};
function ownedClient(ownerPid: number, runtime: ActivationHooks): Record<string, unknown> | null {
  const clients: unknown = JSON.parse(runtime.command("hyprctl", ["-j", "clients"]));
  if (!Array.isArray(clients)) throw new Error("Invalid Hyprland window list");
  const matches = clients.filter((value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object") return false;
    const client = value as Record<string, unknown>;
    if (
      client.class !== "unimatrix-poker" ||
      typeof client.address !== "string" ||
      !/^0x[0-9a-f]+$/i.test(client.address)
    )
      return false;
    let pid = client.pid;
    const seen = new Set<number>();
    while (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) {
      if (pid === ownerPid) return true;
      seen.add(pid);
      pid = runtime.parentPid(pid);
    }
    return false;
  });
  if (matches.length > 1) throw new Error("Cannot restore an ambiguous Poker Lab window");
  return matches[0] || null;
}
function focusedAddress(runtime: ActivationHooks): string | null {
  const value: unknown = JSON.parse(runtime.command("hyprctl", ["-j", "activewindow"]));
  if (
    value &&
    typeof value === "object" &&
    "address" in value &&
    typeof value.address === "string" &&
    /^0x[0-9a-f]+$/i.test(value.address)
  )
    return value.address;
  return null;
}
export function captureWindowPlacement(
  ownerPid: number,
  overrides: Partial<PlacementHooks> = {},
): WindowPlacement | null {
  const runtime = { ...placementHooks, ...overrides };
  if (runtime.platform !== "linux" || !runtime.env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  const client = ownedClient(ownerPid, runtime);
  if (!client) throw new Error("Waiting for the owned Poker Lab window before replacing it");
  const workspace = client.workspace as { id?: unknown; name?: unknown } | null;
  if (
    !workspace ||
    !Number.isSafeInteger(workspace.id) ||
    typeof workspace.name !== "string" ||
    [...workspace.name].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Cannot read Poker Lab's workspace");
  const pair = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && Math.abs(n) <= 1000000,
    );
  if (
    !Number.isSafeInteger(client.monitor) ||
    typeof client.floating !== "boolean" ||
    !pair(client.at) ||
    !pair(client.size) ||
    client.size.some((n) => n <= 0) ||
    ![0, 1, 2, 3].includes(Number(client.fullscreen))
  )
    throw new Error("Cannot read Poker Lab's window placement");
  const focus = focusedAddress(runtime);
  return {
    workspace: workspace.name.startsWith("special:")
      ? workspace.name
      : /^\d+$/.test(workspace.name)
        ? String(workspace.id)
        : `name:${workspace.name}`,
    monitor: Number(client.monitor),
    floating: client.floating,
    at: client.at,
    size: client.size,
    fullscreen: Number(client.fullscreen),
    fullscreenClient: [0, 1, 2, 3].includes(Number(client.fullscreenClient))
      ? Number(client.fullscreenClient)
      : Number(client.fullscreen),
    focusAddress: focus === client.address ? null : focus,
  };
}
function placementDispatch(runtime: ActivationHooks, legacy: string[], lua: string): void {
  try {
    if (runtime.command("hyprctl", ["dispatch", ...legacy]) === "ok") return;
  } catch {
    /* The Lua dispatcher replaced legacy dispatchers. */
  }
  runtime.command("hyprctl", ["eval", `hl.dispatch(${lua})`]);
}
export async function restoreWindowPlacement(
  ownerPid: number,
  placement: WindowPlacement | null,
  overrides: Partial<PlacementHooks> = {},
): Promise<void> {
  const runtime = { ...placementHooks, ...overrides };
  if (runtime.platform !== "linux" || !runtime.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  let focus = placement?.focusAddress ?? null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const client = ownedClient(ownerPid, runtime);
    const active = focusedAddress(runtime);
    if (!client) {
      if (active) focus = active;
      await runtime.wait();
      continue;
    }
    const address = String(client.address),
      target = `address:${address}`,
      window = JSON.stringify(target);
    if (!placement) {
      placementDispatch(
        runtime,
        ["settiled", target],
        `hl.dsp.window.float({ action = "disable", window = ${window} })`,
      );
      if (ownedClient(ownerPid, runtime)?.floating !== false)
        throw new Error("Poker Lab did not enter tiled mode");
      return;
    }
    if (active && active !== address) focus = active;
    runtime.command("hyprctl", [
      "eval",
      `hl.dispatch(hl.dsp.window.move({ monitor = ${JSON.stringify(String(placement.monitor))}, follow = false, window = ${window} }))`,
    ]);
    placementDispatch(
      runtime,
      ["movetoworkspacesilent", `${placement.workspace},${target}`],
      `hl.dsp.window.move({ workspace = ${JSON.stringify(placement.workspace)}, follow = false, window = ${window} })`,
    );
    placementDispatch(
      runtime,
      [placement.floating ? "setfloating" : "settiled", target],
      `hl.dsp.window.float({ action = ${JSON.stringify(placement.floating ? "enable" : "disable")}, window = ${window} })`,
    );
    if (placement.floating) {
      placementDispatch(
        runtime,
        ["resizewindowpixel", `exact ${placement.size[0]} ${placement.size[1]},${target}`],
        `hl.dsp.window.resize({ x = ${placement.size[0]}, y = ${placement.size[1]}, relative = false, window = ${window} })`,
      );
      placementDispatch(
        runtime,
        ["movewindowpixel", `exact ${placement.at[0]} ${placement.at[1]},${target}`],
        `hl.dsp.window.move({ x = ${placement.at[0]}, y = ${placement.at[1]}, relative = false, window = ${window} })`,
      );
    }
    runtime.command("hyprctl", [
      "eval",
      `hl.dispatch(hl.dsp.window.fullscreen_state({ internal = ${placement.fullscreen}, client = ${placement.fullscreenClient}, action = "set", window = ${window} }))`,
    ]);
    if (focus && focusedAddress(runtime) === address)
      placementDispatch(
        runtime,
        ["focuswindow", `address:${focus}`],
        `hl.dsp.focus({ window = ${JSON.stringify(`address:${focus}`)} })`,
      );
    const restored = ownedClient(ownerPid, runtime);
    const actualWorkspace = restored?.workspace as { id?: number; name?: string } | undefined;
    const workspaceMatches = placement.workspace.startsWith("name:")
      ? actualWorkspace?.name === placement.workspace.slice(5)
      : placement.workspace.startsWith("special:")
        ? actualWorkspace?.name === placement.workspace
        : String(actualWorkspace?.id) === placement.workspace;
    if (
      !restored ||
      !workspaceMatches ||
      restored.monitor !== placement.monitor ||
      restored.floating !== placement.floating ||
      Number(restored.fullscreen) !== placement.fullscreen
    )
      throw new Error("Poker Lab window placement readback differs from its saved placement");
    if (
      placement.floating &&
      placement.fullscreen === 0 &&
      (JSON.stringify(restored.at) !== JSON.stringify(placement.at) ||
        JSON.stringify(restored.size) !== JSON.stringify(placement.size))
    )
      throw new Error("Poker Lab floating geometry was not restored");
    if (focus && focusedAddress(runtime) === address)
      throw new Error("Poker Lab replacement could not preserve desktop focus");
    return;
  }
  throw new Error("Poker Lab replacement window did not appear for placement restoration");
}
export function activateExistingWindow(
  ownerPid: number,
  overrides: Partial<ActivationHooks> = {},
): void {
  const runtime = { ...activationHooks, ...overrides };
  const help = "Poker Lab is already running. Open its existing workspace/window.";
  if (runtime.platform !== "linux" || !runtime.env.HYPRLAND_INSTANCE_SIGNATURE)
    throw new Error(`${help} Automatic activation requires a Hyprland desktop session.`);
  const owned = (pid: number) => {
    const seen = new Set<number>();
    while (Number.isSafeInteger(pid) && pid > 1 && !seen.has(pid)) {
      if (pid === ownerPid) return true;
      seen.add(pid);
      pid = runtime.parentPid(pid);
    }
    return false;
  };
  try {
    const clients: unknown = JSON.parse(runtime.command("hyprctl", ["-j", "clients"]));
    if (!Array.isArray(clients)) throw new Error("Invalid Hyprland window list");
    const windows = clients.filter(
      (client: unknown): client is { address: string; pid: number } => {
        if (!client || typeof client !== "object") return false;
        const value = client as Record<string, unknown>;
        return (
          value.class === "unimatrix-poker" &&
          typeof value.address === "string" &&
          /^0x[0-9a-f]+$/i.test(value.address) &&
          typeof value.pid === "number" &&
          owned(value.pid)
        );
      },
    );
    if (windows.length !== 1)
      throw new Error(
        "Cannot identify exactly one window owned by the running launcher; it may still be starting",
      );
    const address = windows[0]!.address;
    try {
      if (runtime.command("hyprctl", ["dispatch", "focuswindow", `address:${address}`]) !== "ok")
        throw new Error("Legacy focus dispatch was rejected");
    } catch {
      runtime.command("hyprctl", [
        "eval",
        `hl.dispatch(hl.dsp.focus({ window = "address:${address}" }))`,
      ]);
    }
    const active = JSON.parse(runtime.command("hyprctl", ["-j", "activewindow"])) as {
      address?: unknown;
    } | null;
    if (active?.address !== address) throw new Error("Hyprland did not focus the Poker Lab window");
  } catch (error) {
    throw new Error(`${help} ${String(error)}`, { cause: error });
  }
}
export interface SupervisorHooks {
  capturePlacement: typeof captureWindowPlacement;
  restorePlacement: typeof restoreWindowPlacement;
  activate: (ownerPid: number) => void;
  notify: (message: string) => void;
  build: typeof buildNative;
  startServer: typeof startViteServer;
  stopServer: typeof stopViteServer;
  launch: (artifact: NativeArtifact, tree: Worktree, common: string) => ChildProcess;
  pause: () => Promise<void>;
  shouldStop: () => boolean;
}
const defaultHooks: SupervisorHooks = {
  capturePlacement: captureWindowPlacement,
  restorePlacement: restoreWindowPlacement,
  activate: activateExistingWindow,
  notify: (message) => {
    spawnSync("notify-send", ["Poker Lab", message], { timeout: 5000, stdio: "ignore" });
  },
  build: buildNative,
  startServer: startViteServer,
  stopServer: stopViteServer,
  launch: (artifact, tree, common) =>
    spawn(artifact.binary, [], {
      cwd: tree.path,
      env: nativeEnvironment(tree, common),
      stdio: ["ignore", "inherit", "inherit"],
    }),
  pause: () => new Promise((done) => setTimeout(done, 1500)),
  shouldStop: () => false,
};
export async function stopChild(child: ChildProcess, timeoutMs = 15000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
}
interface PendingBuild {
  tree: Worktree;
  fingerprint: string;
  controller: AbortController;
  done: boolean;
  artifact: NativeArtifact | null;
  error: Error | null;
  promise: Promise<void>;
}
export async function supervise(
  common: string,
  preferred: string,
  paths = launcherPaths(),
  overrides: Partial<SupervisorHooks> = {},
) {
  const runtime = { ...defaultHooks, ...overrides };
  mkdirSync(paths.cache, { recursive: true, mode: 0o700 });
  try {
    mkdirSync(paths.lock);
  } catch (error) {
    const prior = readJson(join(paths.lock, "owner.json")) as { pid?: number } | null;
    if (prior?.pid && alive(prior.pid)) {
      const state = activeState(paths);
      if (state?.pid === prior.pid && !state.current) {
        return;
      }
      runtime.activate(prior.pid);
      return;
    }
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!prior && Date.now() - statSync(paths.lock).mtimeMs < 30000)
      throw new Error("Poker Lab launcher is starting", { cause: error });
    rmSync(paths.lock, { recursive: true, force: true });
    mkdirSync(paths.lock);
  }
  atomicJson(join(paths.lock, "owner.json"), { pid: process.pid });
  let child: ChildProcess | null = null;
  const isRecording = () => Boolean(child?.pid && recordingActive(child.pid, paths));
  const capturePlacement = () => (child?.pid ? runtime.capturePlacement(child.pid) : null);
  let server: DevServer | null = null;
  let current: Worktree | null = null;
  const active: { artifact: NativeArtifact | null } = { artifact: null };
  let pending: PendingBuild | null = null;
  let foregroundBuild: AbortController | null = null;
  let attempted = "",
    candidate = "",
    preferenceVersion = "";
  let stopping = false,
    manualClose = false;
  const publish = (error: string | null = null) => {
    atomicJson(paths.state, { pid: process.pid, current, error });
  };
  const terminate = () => {
    stopping = true;
    pending?.controller.abort();
    foregroundBuild?.abort();
  };
  const launch = (tree: Worktree, entry: NativeArtifact) => {
    const launched = runtime.launch(entry, tree, common);
    child = launched;
    current = tree;
    active.artifact = entry;
    launched.once("exit", () => {
      if (launched.pid) clearRecording(launched.pid, paths);
      if (child === launched) {
        manualClose = true;
        current = null;
        pending?.controller.abort();
        foregroundBuild?.abort();
        publish();
      }
    });
    launched.once("error", (error) => {
      if (child === launched) {
        child = null;
        current = null;
        stopping = true;
        pending?.controller.abort();
        publish(String(error));
      }
    });
    publish();
    return launched;
  };
  const launchRestored = async (
    tree: Worktree,
    entry: NativeArtifact,
    placement: WindowPlacement | null,
  ) => {
    const launched = launch(tree, entry);
    if (launched.pid) {
      try {
        await runtime.restorePlacement(
          launched.pid,
          placement ? { ...placement, floating: false } : null,
        );
      } catch (error) {
        publish(
          `Poker Lab reopened, but its window placement could not be restored: ${String(error)}`,
        );
      }
    }
  };
  const stopApp = async () => {
    if (child) {
      const previous = child;
      child = null;
      await stopChild(previous);
    }
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    publish();
    while (!stopping && !manualClose && !runtime.shouldStop()) {
      const status = launcherStatus(common, preferred, paths);
      try {
        if (!status.desired) throw new Error(status.error || "Selected worktree unavailable");
        const desired = status.desired;
        const version = existsSync(paths.preference)
          ? String(statSync(paths.preference).mtimeMs)
          : "default";
        if (version !== preferenceVersion) {
          attempted = "";
          preferenceVersion = version;
        }
        if (!child || current?.id !== desired.id) {
          if (isRecording()) {
            publish("Checkout change queued until recording stops");
            await runtime.pause();
            continue;
          }
          if (pending) {
            pending.controller.abort();
            await pending.promise;
            pending = null;
          }
          let ready = readNativeCache(desired, paths);
          if (!ready) {
            foregroundBuild = new AbortController();
            publish("Building the native development app for this worktree");
            try {
              ready = await runtime.build(desired, paths, foregroundBuild.signal);
            } finally {
              foregroundBuild = null;
            }
          }
          if (stopping || manualClose || runtime.shouldStop()) break;
          if (isRecording()) {
            publish("Checkout change queued until recording stops");
            await runtime.pause();
            continue;
          }
          const previous = current,
            previousArtifact = active.artifact;
          const placement = capturePlacement();
          if (isRecording()) {
            publish("Checkout change queued until recording stops");
            await runtime.pause();
            continue;
          }
          await stopApp();
          if (server) {
            await runtime.stopServer(server);
            server = null;
          }
          try {
            server = await runtime.startServer(desired);
            await launchRestored(desired, ready, placement);
          } catch (error) {
            if (previous && previousArtifact) {
              server = await runtime.startServer(previous);
              await launchRestored(previous, previousArtifact, placement);
            }
            throw error;
          }
        } else {
          current = desired;
          if (pending?.done) {
            if (
              isRecording() &&
              pending.artifact &&
              pending.tree.id === current.id &&
              nativeFingerprint(current) === pending.fingerprint
            ) {
              publish("Native update ready; waiting for recording to stop");
              await runtime.pause();
              continue;
            }
            const completed: PendingBuild = pending;
            pending = null;
            if (completed.error) publish(String(completed.error));
            else if (
              completed.artifact &&
              completed.tree.id === current.id &&
              nativeFingerprint(current) === completed.fingerprint
            ) {
              const placement = capturePlacement();
              if (isRecording()) {
                pending = completed;
                publish("Native update ready; waiting for recording to stop");
                await runtime.pause();
                continue;
              }
              await stopApp();
              if (!stopping && !manualClose)
                await launchRestored(current, completed.artifact, placement);
            }
          }
        }
        if (current && active.artifact) {
          const fingerprint = nativeFingerprint(current);
          const key = `${current.id}:${fingerprint}`;
          if (
            !pending &&
            fingerprint !== active.artifact.fingerprint &&
            key !== attempted &&
            key === candidate
          ) {
            attempted = key;
            const build: PendingBuild = {
              tree: current,
              fingerprint,
              controller: new AbortController(),
              done: false,
              artifact: null,
              error: null,
              promise: Promise.resolve(),
            };
            pending = build;
            build.promise = runtime
              .build(current, paths, build.controller.signal)
              .then((built) => {
                build.artifact = built;
              })
              .catch((error: unknown) => {
                build.error =
                  error instanceof Error
                    ? error
                    : new Error("Native build failed", { cause: error });
              })
              .finally(() => {
                build.done = true;
              });
          }
          candidate = key;
        }
      } catch (error) {
        console.error(String(error));
        publish(String(error));
        if (!child) throw error;
      }
      if (!manualClose && !stopping && !runtime.shouldStop()) await runtime.pause();
    }
  } finally {
    pending?.controller.abort();
    if (pending) await pending.promise;
    await stopApp();
    if (server) await runtime.stopServer(server);
    rmSync(paths.state, { force: true });
    rmSync(paths.lock, { recursive: true, force: true });
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", terminate);
  }
}
export async function main(args = process.argv.slice(2)) {
  const commonIndex = args.indexOf("--git-dir");
  const supplied = commonIndex >= 0 ? args[commonIndex + 1] : undefined;
  if (!supplied || !isAbsolute(supplied))
    throw new Error("--git-dir requires an absolute Git common directory");
  const common = realpathSync(supplied);
  const origin =
    process.env.POKER_LAB_PREFERRED_WORKTREE ||
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const trees = discoverWorktrees(common);
  const preferred =
    trees.find((tree) => tree.path === resolve(origin))?.path || trees[0]?.path || origin;
  const rest = args.filter((_, index) => index !== commonIndex && index !== commonIndex + 1);
  if (rest.length === 1 && rest[0] === "--status")
    console.log(JSON.stringify(launcherStatus(common, preferred)));
  else if (rest.length === 2 && rest[0] === "--select" && rest[1])
    console.log(JSON.stringify(selectWorktree(common, preferred, rest[1])));
  else if (
    rest.length === 4 &&
    rest[0] === "--recording" &&
    (rest[2] === "gameplay" || rest[2] === "collector") &&
    (rest[3] === "on" || rest[3] === "off")
  ) {
    setRecordingIntent(Number(rest[1]), rest[2], rest[3] === "on");
    console.log(JSON.stringify({ ok: true }));
  } else if (rest.length === 2 && rest[0] === "--seed-native" && rest[1] && isAbsolute(rest[1])) {
    const tree = chooseWorktree(common, trees, selectionAt(launcherPaths()), preferred);
    console.log(JSON.stringify(seedNativeCache(tree, rest[1])));
  } else if (!rest.length) await supervise(common, preferred);
  else
    throw new Error(
      "Expected --status, --select <latest|worktree identity>, --seed-native <absolute development binary>, or no operation",
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(String(error));
    if (
      process.platform === "linux" &&
      !process.argv.some((arg) =>
        ["--status", "--select", "--recording", "--seed-native"].includes(arg),
      )
    )
      spawnSync("notify-send", ["--urgency=critical", "Poker Lab could not open", String(error)], {
        timeout: 5000,
        stdio: "ignore",
      });
    process.exitCode = 1;
  });
}
