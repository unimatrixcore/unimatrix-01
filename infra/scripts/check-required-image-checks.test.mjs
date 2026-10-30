import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkRequiredImageChecks,
  imageCheckContexts,
  readRequiredContexts,
  requiredContexts,
} from "./check-required-image-checks.mjs";

const rule = (...contexts) => ({
  type: "required_status_checks",
  parameters: { required_status_checks: contexts.map((context) => ({ context })) },
});
const response = (rules) => new Response(JSON.stringify(rules));
function fixture(t, apps = ["api", "new-app"]) {
  const root = mkdtempSync(join(tmpdir(), "required-image-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps", "undeployed"), { recursive: true });
  for (const app of apps) {
    mkdirSync(join(root, "apps", app), { recursive: true });
    writeFileSync(join(root, "apps", app, "Dockerfile"), "FROM scratch\n");
  }
  return root;
}

test("derives contexts from Dockerfiles and refuses an empty inventory", (t) => {
  assert.deepEqual(imageCheckContexts(fixture(t)), ["Images (api)", "Images (new-app)"]);
  assert.throws(() => imageCheckContexts(fixture(t, [])), /No apps\/\*\/Dockerfile/);
});

test("accepts effective requirements across rules, preserving exact context names", () => {
  assert.deepEqual(
    requiredContexts([{ type: "pull_request" }, rule("Images (api)"), rule("Images (web)")]),
    ["Images (api)", "Images (web)"],
  );
});

test("passes only when every Dockerfile has an exact required check", async (t) => {
  const root = fixture(t);
  await checkRequiredImageChecks({
    root,
    fetchImpl: async () => response([rule("Images (api)", "Images (new-app)")]),
  });
  await assert.rejects(
    checkRequiredImageChecks({
      root,
      fetchImpl: async () => response([rule("Images (api)", "Images (new-app) ")]),
    }),
    /Add these exact required status check contexts[\s\S]*\n  Images \(new-app\)$/,
  );
  await assert.rejects(
    checkRequiredImageChecks({ root, fetchImpl: async () => response([]) }),
    /Images \(api\)[\s\S]*Images \(new-app\)/,
  );
});

test("reads anonymous upstream rules and follows every page", async () => {
  const requests = [];
  const contexts = await readRequiredContexts(async (url, options) => {
    requests.push(url);
    assert.equal(new URL(url).pathname, "/repos/unimatrixcore/unimatrix-01/rules/branches/main");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.signal.aborted, false);
    return response(
      requests.length === 1
        ? Array.from({ length: 100 }, () => ({ type: "pull_request" }))
        : [rule("Images (api)")],
    );
  });
  assert.deepEqual([...contexts], ["Images (api)"]);
  assert.equal(new URL(requests[1]).searchParams.get("page"), "2");
});

test("rejects unreadable or malformed rules rather than silently passing", async () => {
  for (const body of [
    {},
    [null],
    [{}],
    [{ type: "required_status_checks" }],
    [rule(null)],
    [rule("")],
  ]) {
    await assert.rejects(
      readRequiredContexts(async () => response(body)),
      /GitHub/,
    );
  }
  for (const status of [302, 403, 404, 500]) {
    await assert.rejects(
      readRequiredContexts(async () => new Response("", { status })),
      new RegExp(`HTTP ${status}`),
    );
  }
  await assert.rejects(
    readRequiredContexts(async () => new Response("not json")),
    /valid JSON/,
  );
  await assert.rejects(
    readRequiredContexts(async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
});

test("fails closed if pagination never terminates", async () => {
  await assert.rejects(
    readRequiredContexts(async () =>
      response(Array.from({ length: 100 }, () => ({ type: "pull_request" }))),
    ),
    /pagination limit/,
  );
});
