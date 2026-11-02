import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCoverageDrift } from "./check-coverage-drift.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "coverage-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const logs = [];
  return {
    root,
    logs,
    config(path, source = "thresholds: { statements: 90, functions: 90 }") {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "vitest.config.ts"), source);
      execFileSync("git", ["add", `${path}/vitest.config.ts`], { cwd: root });
    },
    summary(path, statements = 93, functions = 93) {
      mkdirSync(join(root, path, "coverage"), { recursive: true });
      writeFileSync(
        join(root, path, "coverage/coverage-summary.json"),
        JSON.stringify({
          total: { statements: { pct: statements }, functions: { pct: functions } },
        }),
      );
    },
    check(selected = null) {
      return checkCoverageDrift(root, selected, (line) => logs.push(line));
    },
  };
}

test("compares only selected workspaces even if unrelated stale summaries exist", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  f.config("apps/admin");
  f.summary("apps/web");
  f.summary("apps/admin", 1, 100);
  assert.deepEqual(f.check(["apps/web"]), { failures: 0, compared: 2, expected: 1 });
});

test("a missing selected summary fails even when another summary exists", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  f.config("apps/admin");
  f.summary("apps/web");
  assert.equal(f.check(["apps/web", "apps/admin"]).failures, 1);
  assert.match(f.logs.join("\n"), /apps\/admin: missing coverage/u);
});

test("default full mode also refuses missing summaries", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  f.config("apps/admin");
  f.summary("apps/web");
  assert.equal(f.check().failures, 1);
});

test("explicitly empty and Node-test-only selections pass without Vitest artifacts", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  assert.deepEqual(f.check([]), { failures: 0, compared: 0, expected: 0 });
  assert.deepEqual(f.check(["apps/api"]), { failures: 0, compared: 0, expected: 0 });
});

test("an empty full inventory cannot pass vacuously", (t) => {
  assert.equal(fixture(t).check().failures, 1);
});

test("floor drift, below-floor values and invalid percentages all fail", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  for (const [statements, functions] of [
    [99, 93],
    [89, 93],
    [null, 93],
    [101, 93],
  ]) {
    f.summary("apps/web", statements, functions);
    assert.equal(f.check(["apps/web"]).failures, 1);
  }
});

test("malformed summary and unreadable threshold expressions fail", (t) => {
  const f = fixture(t);
  f.config("apps/web");
  f.summary("apps/web");
  writeFileSync(join(f.root, "apps/web/coverage/coverage-summary.json"), "not JSON");
  assert.equal(f.check(["apps/web"]).failures, 1);
  f.config("apps/web", "thresholds: { ...unknown }");
  assert.equal(f.check(["apps/web"]).failures, 1);
});
