import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  chooseWorktree,
  discoverWorktrees,
  launcherPaths,
  launcherStatus,
  selectWorktree,
  sourceFingerprint,
  nativeFingerprint,
  nativeEnvironment,
  seedNativeCache,
  readNativeCache,
  stopChild,
  supervise,
} from "../scripts/launch.js";

const temporary: string[] = [];
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
    Buffer.from("safe dummy fixture"),
  ]);
  writeFileSync(binary, bytes);
  const invalid = seedNativeCache(tree, binary, paths, fingerprint);
  expect(readFileSync(invalid.binary)).toEqual(bytes);
  vi.stubEnv("PATH", "/missing-strip-tool");
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
function fakeProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}
it("starts from persistent verified cache without a build and keeps the native PID for UI edits until manual close", async () => {
  const { common, repo, paths } = fixture();
  const tree = discoverWorktrees(common).find((item) => item.path === repo)!;
  const binary = join(paths.cache, "fixture-native");
  mkdirSync(paths.cache, { recursive: true });
  writeFileSync(binary, "fixture executable");
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
  writeFileSync(binary, "verified old build");
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
  expect(readNativeCache(tree, paths)).toEqual(cached);
  writeFileSync(cached.binary, "tampered");
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
