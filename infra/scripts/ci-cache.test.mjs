import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const turboBin = join(dirname(require.resolve("turbo/package.json")), "bin", "turbo");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ci-cache-hashes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": JSON.stringify({
      name: "cache-fixture",
      private: true,
      packageManager: "pnpm@10.30.3",
    }),
    "turbo.json": readFileSync(join(repoRoot, "turbo.json"), "utf8"),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "pnpm-lock.yaml":
      "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  apps/app:\n    devDependencies:\n      '@test/config':\n        specifier: workspace:*\n        version: link:../../packages/config\n  packages/config: {}\n  packages/tv: {}\n",
    ".node-version": "24.18.0\n",
    ".npmrc": "engine-strict=true\n",
    ".gitignore": ".env*\n.turbo\n",
    "apps/app/package.json": JSON.stringify({
      name: "@test/app",
      scripts: {
        build: "echo build",
        lint: "echo lint",
        typecheck: "echo typecheck",
        test: "echo test",
      },
      devDependencies: { "@test/config": "workspace:*" },
    }),
    "apps/app/index.ts": "export const value = 1;\n",
    "packages/config/package.json": JSON.stringify({ name: "@test/config" }),
    "packages/config/index.mjs": "export default { strict: true };\n",
    "packages/tv/package.json": JSON.stringify({
      name: "@unimatrix/tv",
      scripts: { build: "echo tv", test: "echo test" },
    }),
  };
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}

function dryRun(root, env = {}) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TURBO_") || name.startsWith("VITE_") || name === "NODE_ENV")
      delete environment[name];
  }
  const result = execFileSync(
    process.execPath,
    [turboBin, "run", "build", "lint", "typecheck", "test", "--dry=json", "--no-daemon"],
    {
      cwd: root,
      env: { ...environment, TURBO_TELEMETRY_DISABLED: "1", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(result);
}

function appHashes(run) {
  return Object.fromEntries(
    ["build", "lint", "typecheck"].map((task) => {
      const result = run.tasks.find((item) => item.taskId === `@test/app#${task}`);
      assert.ok(result, `expected ${task} in dry run`);
      return [task, result.hash];
    }),
  );
}

test("shared source-only config changes invalidate build, lint, and typecheck consumers", (t) => {
  const root = fixture(t);
  const before = appHashes(dryRun(root));
  writeFileSync(join(root, "packages/config/index.mjs"), "export default { strict: false };\n");
  const after = appHashes(dryRun(root));
  for (const task of Object.keys(before)) assert.notEqual(after[task], before[task], task);
});

test("Vite and NODE_ENV values invalidate the app build", (t) => {
  const root = fixture(t);
  const before = appHashes(dryRun(root)).build;
  assert.notEqual(
    appHashes(dryRun(root, { VITE_API_BASE_URL: "https://example.invalid" })).build,
    before,
  );
  assert.notEqual(appHashes(dryRun(root, { NODE_ENV: "production" })).build, before);
});

test("ignored app dotenv files still invalidate build outputs", (t) => {
  const root = fixture(t);
  const dotenv = join(root, "apps/app/.env.local");
  writeFileSync(dotenv, "VITE_LABEL=first\n");
  execFileSync("git", ["check-ignore", "--quiet", "apps/app/.env.local"], { cwd: root });
  const before = appHashes(dryRun(root)).build;
  writeFileSync(dotenv, "VITE_LABEL=second\n");
  assert.notEqual(appHashes(dryRun(root)).build, before);
});

test("root toolchain pins invalidate every static task", (t) => {
  const root = fixture(t);
  const before = appHashes(dryRun(root));
  for (const file of [".node-version", ".npmrc", "pnpm-workspace.yaml"]) {
    const original = readFileSync(join(root, file), "utf8");
    writeFileSync(join(root, file), `${original}\n# changed fixture pin\n`);
    const after = appHashes(dryRun(root));
    for (const task of Object.keys(before))
      assert.notEqual(after[task], before[task], `${file}: ${task}`);
    writeFileSync(join(root, file), original);
  }
});

test("tests and the TV runtime build remain uncached", (t) => {
  const root = fixture(t);
  const run = dryRun(root);
  const tests = run.tasks.filter((item) => item.task === "test");
  assert.ok(tests.length > 0);
  for (const task of tests) assert.equal(task.resolvedTaskDefinition.cache, false, task.taskId);
  const tvBuild = run.tasks.find((item) => item.taskId === "@unimatrix/tv#build");
  assert.ok(tvBuild);
  assert.equal(tvBuild.resolvedTaskDefinition.cache, false);
  assert.deepEqual(tvBuild.resolvedTaskDefinition.dependsOn, ["^build"]);
  assert.deepEqual(tvBuild.resolvedTaskDefinition.outputs, ["dist/**"]);
});
