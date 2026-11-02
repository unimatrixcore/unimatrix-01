import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCIPlan,
  discoverWorkspaces,
  readChangedPaths,
  readCIPlan,
  runPlanTask,
  main,
} from "./ci-plan.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ci-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifests = {
    "packages/ui": { name: "@unimatrix/ui" },
    "packages/cube": { name: "@unimatrix/cube", dependencies: { "@unimatrix/ui": "workspace:*" } },
    "packages/config-vitest": { name: "@unimatrix/config-vitest" },
    "apps/api": {
      name: "@unimatrix/api",
      devDependencies: { "@unimatrix/config-vitest": "workspace:*" },
    },
    "apps/admin": {
      name: "@unimatrix/admin",
      dependencies: { "@unimatrix/ui": "workspace:*" },
      devDependencies: { "@unimatrix/config-vitest": "workspace:*" },
    },
    "apps/web": { name: "@unimatrix/web", dependencies: { "@unimatrix/ui": "workspace:*" } },
    "apps/cflop": { name: "@unimatrix/cflop", dependencies: { "@unimatrix/cube": "workspace:*" } },
    "apps/status": { name: "@unimatrix/status", dependencies: { "@unimatrix/ui": "workspace:*" } },
    "packages/unimatrix-tv": { name: "@unimatrix/tv" },
    lab: { name: "@unimatrix/lab", dependencies: { "@unimatrix/ui": "workspace:*" } },
  };
  for (const [path, manifest] of Object.entries(manifests)) {
    mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, path, "package.json"), JSON.stringify(manifest));
  }
  const workspaces = discoverWorkspaces(root);
  return {
    root,
    workspaces,
    plan: (...changedPaths) => createCIPlan({ workspaces, changedPaths }),
  };
}

const paths = (plan) => plan.packages.map(({ path }) => path);

test("guidance-only changes select no package work or setup", (t) => {
  const { plan } = fixture(t);
  const result = plan(
    "README.md",
    "AGENTS.md",
    "docs/content.md",
    ".agents/skills/ship-pr/SKILL.md",
  );
  assert.equal(result.full, false);
  assert.deepEqual(result.packages, []);
  assert.equal(result.browser, false);
  assert.equal(result.dotnet, false);
  assert.deepEqual(result.lighthouse, []);
});

test("backend-only changes do not install browsers or run Lighthouse", (t) => {
  const result = fixture(t).plan("apps/api/src/app.ts");
  assert.deepEqual(paths(result), ["apps/api"]);
  assert.equal(result.browser, false);
  assert.equal(result.dotnet, false);
});

test("app-local changes and home copy stay confined to their app", (t) => {
  const { plan } = fixture(t);
  assert.deepEqual(paths(plan("apps/admin/src/page.tsx")), ["apps/admin"]);
  const web = plan("apps/web/src/features/content/home.md");
  assert.deepEqual(paths(web), ["apps/web"]);
  assert.equal(web.browser, true);
  assert.deepEqual(web.lighthouse, ["apps/web"]);
  assert.deepEqual(plan("apps/status/src/main.tsx").lighthouse, []);
});

test("shared dependencies select transitive consumers including lab", (t) => {
  const { plan } = fixture(t);
  assert.deepEqual(paths(plan("packages/cube/src/index.ts")), ["apps/cflop", "packages/cube"]);
  assert.deepEqual(paths(plan("packages/ui/src/button.tsx")), [
    "apps/admin",
    "apps/cflop",
    "apps/status",
    "apps/web",
    "lab",
    "packages/cube",
    "packages/ui",
  ]);
});

test("shared config devDependencies propagate checks", (t) => {
  assert.deepEqual(paths(fixture(t).plan("packages/config-vitest/src/index.ts")), [
    "apps/admin",
    "apps/api",
    "packages/config-vitest",
  ]);
});

test("unknown, toolchain, lockfile and executable guidance paths request full checks", (t) => {
  const { plan, workspaces } = fixture(t);
  for (const path of [
    "pnpm-lock.yaml",
    "turbo.json",
    "package.json",
    ".node-version",
    ".github/workflows/ci.yml",
    "infra/scripts/lighthouse.mjs",
    ".agents/skills/tool/scripts/run.mjs",
    "new-asset.svg",
    "apps/deleted/package.json",
  ]) {
    const result = plan(path);
    assert.equal(result.full, true, path);
    assert.equal(result.packages.length, workspaces.length, path);
    assert.equal(result.dotnet, true);
  }
});

test("explicit full runs include all workspaces", (t) => {
  const { workspaces } = fixture(t);
  const result = createCIPlan({ workspaces, fullReason: "push runs verify every workspace" });
  assert.equal(result.full, true);
  assert.equal(result.packages.length, workspaces.length);
});

test("malformed manifest inventory and changed paths fail instead of selecting nothing", (t) => {
  const { root, plan } = fixture(t);
  assert.throws(() => plan("../escape"), /Invalid changed path/u);
  writeFileSync(join(root, "apps/api/package.json"), JSON.stringify({ name: "@unimatrix/ui" }));
  assert.throws(() => discoverWorkspaces(root), /Duplicate workspace/u);
});

test("malformed dependency declarations cannot silently remove graph edges", (t) => {
  const { root } = fixture(t);
  writeFileSync(
    join(root, "apps/api/package.json"),
    JSON.stringify({ name: "@unimatrix/api", dependencies: ["@unimatrix/ui"] }),
  );
  assert.throws(() => discoverWorkspaces(root), /Invalid dependencies/u);
});

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("Git comparison captures deletes and both sides of a rename with unusual filenames", (t) => {
  const { root, plan } = fixture(t);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "CI fixture");
  git(root, "config", "user.email", "ci@example.invalid");
  writeFileSync(join(root, "apps/api", "old\nfile.ts"), "same content\n");
  writeFileSync(join(root, "apps/web", "deleted.ts"), "remove me\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "mv", "apps/api/old\nfile.ts", "apps/admin/new\nfile.ts");
  git(root, "rm", "apps/web/deleted.ts");
  git(root, "commit", "-m", "rename and delete");
  const comparison = readChangedPaths(root, base, git(root, "rev-parse", "HEAD"));
  assert.deepEqual(comparison.changedPaths.sort(), [
    "apps/admin/new\nfile.ts",
    "apps/api/old\nfile.ts",
    "apps/web/deleted.ts",
  ]);
  assert.deepEqual(paths(plan(...comparison.changedPaths)), ["apps/admin", "apps/api", "apps/web"]);
});

test("missing history selects full checks; malformed comparison SHAs fail", (t) => {
  const { root, workspaces } = fixture(t);
  const comparison = readChangedPaths(root, "a".repeat(40), "b".repeat(40));
  assert.match(comparison.fullReason, /history is unavailable/u);
  assert.equal(createCIPlan({ workspaces, ...comparison }).full, true);
  assert.match(readChangedPaths(root, undefined, undefined).fullReason, /unavailable/u);
  assert.throws(
    () => readChangedPaths(root, "--output=bad", "a".repeat(40)),
    /complete commit SHAs/u,
  );
  assert.throws(
    () => readChangedPaths(root, "a".repeat(41), "b".repeat(40)),
    /complete commit SHAs/u,
  );
});

test("CLI emits validated full plans and setup outputs on non-PR runs", (t) => {
  const { root: temporary } = fixture(t);
  const output = join(temporary, "full-plan.json");
  const githubOutput = join(temporary, "github-output");
  main(["--event", "workflow_dispatch", "--output", output], { GITHUB_OUTPUT: githubOutput });
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const plan = readCIPlan(repoRoot, output);
  assert.equal(plan.full, true);
  assert.match(readFileSync(githubOutput, "utf8"), /full=true\nhas_tasks=true\n/u);
});

test("malformed CLI arguments and malformed event payloads fail", (t) => {
  const { root } = fixture(t);
  assert.throws(() => main(["--unknown", "value"], {}), /Invalid CI planner argument/u);
  assert.throws(() => main(["--event", "pull_request"], {}), /requires --output/u);
  const event = join(root, "event.json");
  writeFileSync(event, "bad JSON");
  assert.throws(
    () =>
      main(["--event", "pull_request", "--output", join(root, "plan.json")], {
        GITHUB_EVENT_PATH: event,
      }),
    SyntaxError,
  );
});

test("plan loading refuses forged flags, unknown names, missing consumers and incomplete full plans", (t) => {
  const { root, plan } = fixture(t);
  const path = join(root, "plan.json");
  function write(value) {
    writeFileSync(path, JSON.stringify(value));
  }
  const valid = plan("apps/api/src/app.ts");
  write(valid);
  assert.deepEqual(readCIPlan(root, path), valid);
  for (const change of [
    { packages: [{ name: "--evil", path: "apps/api" }] },
    { browser: true },
    { packages: [valid.packages[0], valid.packages[0]] },
    { full: true },
    { packages: [{ name: "@unimatrix/ui", path: "packages/ui" }], browser: false, lighthouse: [] },
  ]) {
    write({ ...valid, ...change });
    assert.throws(() => readCIPlan(root, path), /CI plan/u);
  }
});

test("task runner uses bounded package arguments and keeps test concurrency", (t) => {
  const { root, plan } = fixture(t);
  const calls = [];
  runPlanTask(root, plan("apps/api/src/app.ts"), "test", (...args) => calls.push(args));
  assert.deepEqual(calls[0][1], [
    "exec",
    "turbo",
    "run",
    "test",
    "--filter=@unimatrix/api",
    "--concurrency=2",
  ]);
  runPlanTask(root, plan("README.md"), "build", () => assert.fail("empty plan executed a task"));
  assert.throws(() => runPlanTask(root, plan(), "deploy"), /Unsupported CI task/u);
});

test("a failed selected process remains a failed check", (t) => {
  const { root, plan } = fixture(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "pnpm");
  writeFileSync(executable, "#!/bin/sh\nexit 17\n");
  chmodSync(executable, 0o755);
  const execute = (command, args, options) =>
    execFileSync(command, args, {
      ...options,
      stdio: "ignore",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  assert.throws(
    () => runPlanTask(root, plan("apps/api/src/app.ts"), "test", execute),
    (error) => error.status === 17,
  );
});
