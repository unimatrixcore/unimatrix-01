import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { deployCi } from "./deploy-ci.mjs";
import { publicationFromPush, publishImage } from "./publish-image.mjs";

const commit = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const idFor = (app) =>
  `00000000-0000-4000-8000-${Buffer.from(app).toString("hex").padStart(12, "0")}`;
function setup(t, apps = ["api", "auth"]) {
  const root = mkdtempSync(join(tmpdir(), "deploy-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  mkdirSync(join(root, "publication"));
  for (const app of apps) {
    writeFileSync(join(root, "infra/docker", `${app}-compose.yaml`), "");
    writeFileSync(
      join(root, "publication", `${app}.json`),
      JSON.stringify({
        app,
        image: {
          repository: `ghcr.io/unimatrixcore/unimatrix-${app}`,
          tag: commit,
          commit,
          platform: "linux/amd64",
          digestKind: "manifest",
          digest,
        },
      }),
    );
  }
  const env = {
    IMAGE_TAG: commit,
    DOKPLOY_URL: "https://dokploy.example",
    DOKPLOY_API_KEY: "private-key",
    CF_ACCESS_CLIENT_ID: "private-id",
    CF_ACCESS_CLIENT_SECRET: "private-secret",
    DEPLOY_ATTEMPTS_ENABLED: "true",
    DEPLOY_REPORT_URL: "https://report.example",
    DEPLOY_REPORT_TOKEN: "private-token",
    GITHUB_REPOSITORY: "unimatrixcore/unimatrix-01",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const calls = [];
  const states = new Map();
  async function fetchImpl(url, options) {
    const path = new URL(url).pathname;
    const body = options.body && JSON.parse(options.body);
    calls.push({ path, body });
    assert.equal(options.redirect, "manual");
    if (path === "/api/project.all")
      return Response.json([
        {
          projectId: "project",
          environments: [{ compose: apps.map((name) => ({ name, composeId: `compose-${name}` })) }],
        },
      ]);
    if (path === "/health")
      return Response.json(
        { service: "deploy", status: "ok" },
        {
          headers: { "X-Deploy-Capabilities": "commit-subject-v1" },
        },
      );
    if (path === "/deployment/attempts/intent") {
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.headers.Authorization, "Bearer private-token");
      const state = { ...body, id: idFor(body.app), tagWrite: null, queue: null };
      states.set(state.id, state);
      return Response.json(state);
    }
    if (path === "/deployment/execute") {
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.headers.Authorization, "Bearer private-token");
      const state = states.get(body.attemptId);
      assert.equal(body.app, state.app);
      state.tagWrite = "acknowledged";
      state.queue = "acknowledged";
      return Response.json(state);
    }
    if (path === "/api/domain.byComposeId") return Response.json([]);
    throw new Error("Unexpected request");
  }
  return { root, env, calls, fetchImpl, log: () => undefined };
}

test("intent records the deployed commit's public subject without shell interpretation", async (t) => {
  const fixture = setup(t, ["api"]);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fixture.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git(["init"]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "feat: deploy $(private) `literal` subject",
  ]);
  const revision = git(["rev-parse", "HEAD"]);
  fixture.env.IMAGE_TAG = revision;
  const path = join(fixture.root, "publication/api.json");
  const publication = JSON.parse(readFileSync(path, "utf8"));
  publication.image.tag = revision;
  publication.image.commit = revision;
  writeFileSync(path, JSON.stringify(publication));
  await deployCi(fixture);
  assert.equal(
    fixture.calls.find(({ path: route }) => route === "/deployment/attempts/intent").body
      .commitSubject,
    "feat: deploy $(private) `literal` subject",
  );
});

test("captures the digest returned by that publication, refusing missing or ambiguous push evidence", () => {
  const image = { repository: "ghcr.io/unimatrixcore/unimatrix-api", tag: commit, app: "api" };
  assert.equal(
    publicationFromPush(`${commit}: digest: ${digest} size: 1234\n`, image).image.digest,
    digest,
  );
  assert.throws(() => publicationFromPush("push failed", image));
  assert.throws(() => publicationFromPush(`main: digest: ${digest} size: 1`, image));
  assert.throws(() =>
    publicationFromPush(
      `main: digest: ${digest} size: 1\n${commit}: digest: ${digest} size: 2`,
      image,
    ),
  );
});

test("publication retains the SHA push digest even when moving main reports another digest", (t) => {
  const fixture = setup(t, ["api"]);
  const calls = [];
  const output = join(fixture.root, "captured");
  publishImage(
    {
      IMAGE: "ghcr.io/unimatrixcore/unimatrix-api",
      REVISION: commit,
      APP: "api",
      IS_MAIN_PUSH: "true",
    },
    (_command, args) => {
      calls.push(args);
      const isMain = args.at(-1).endsWith(":main");
      return {
        status: 0,
        stdout: `${isMain ? "main" : commit}: digest: ${isMain ? `sha256:${"c".repeat(64)}` : digest} size: 1\n`,
        stderr: "",
      };
    },
    output,
  );
  assert.equal(JSON.parse(readFileSync(join(output, "api.json"), "utf8")).image.digest, digest);
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ["push", "--platform", "linux/amd64"],
      ["push", "--platform", "linux/amd64"],
    ],
  );
});

test("a failed publication does not produce deployable image evidence", (t) => {
  const fixture = setup(t, ["api"]);
  const output = join(fixture.root, "captured");
  assert.throws(
    () =>
      publishImage(
        { IMAGE: "ghcr.io/unimatrixcore/unimatrix-api", REVISION: commit, APP: "api" },
        () => ({ status: 1, stdout: `${commit}: digest: ${digest} size: 1` }),
        output,
      ),
    /Image push failed/,
  );
  assert.equal(existsSync(join(output, "api.json")), false);
});

test("reserves every intent before service execution and never writes Dokploy directly", async (t) => {
  const fixture = setup(t);
  const messages = [];
  await deployCi({ ...fixture, log: (message) => messages.push(message) });
  const { calls } = fixture;
  const executionIndex = calls.findIndex(({ path }) => path === "/deployment/execute");
  assert.equal(
    calls.slice(0, executionIndex).filter(({ path }) => path.endsWith("/intent")).length,
    2,
  );
  assert.deepEqual(
    calls.filter(({ path }) => path === "/deployment/execute").map(({ body }) => body),
    [
      { app: "api", attemptId: idFor("api") },
      { app: "auth", attemptId: idFor("auth") },
    ],
  );
  assert.equal(
    calls.some(({ path }) =>
      ["/api/project.update", "/api/compose.update", "/api/compose.deploy"].includes(path),
    ),
    false,
  );
  assert.match(messages.at(-1), /Queued is not applied/);
});

test("the deployment service executes last so its restart cannot interrupt sibling execution", async (t) => {
  const fixture = setup(t, ["deploy", "web", "api"]);
  await deployCi(fixture);
  assert.deepEqual(
    fixture.calls.filter(({ path }) => path === "/deployment/execute").map(({ body }) => body.app),
    ["api", "web", "deploy"],
  );
});

test("an unavailable intent prevents all execution and retries only the durable reservation", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  let reports = 0;
  fixture.fetchImpl = async (url, options) =>
    url.endsWith("/intent")
      ? (reports++, new Response("", { status: 503 }))
      : original(url, options);
  await assert.rejects(deployCi(fixture), /Durable deployment report unavailable/);
  assert.equal(reports, 3);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/deployment/execute"),
    false,
  );
});

test("a conflicting rollback reservation prevents execution without retrying the conflict", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  let reservations = 0;
  fixture.fetchImpl = async (url, options) =>
    url.endsWith("/intent")
      ? (reservations++, new Response("private error", { status: 409 }))
      : original(url, options);
  await assert.rejects(deployCi(fixture), /Durable deployment report unavailable/);
  assert.equal(reservations, 1);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/deployment/execute"),
    false,
  );
});

test("missing publication or reporting configuration fails before discovery or writes", async (t) => {
  for (const missing of [
    "DEPLOY_REPORT_TOKEN",
    "DEPLOY_REPORT_URL",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ]) {
    const fixture = setup(t);
    delete fixture.env[missing];
    await assert.rejects(deployCi(fixture));
    assert.equal(fixture.calls.length, 0);
  }
  const fixture = setup(t);
  rmSync(join(fixture.root, "publication/api.json"));
  await assert.rejects(deployCi(fixture), /Missing publication/);
  assert.equal(fixture.calls.length, 0);
});

test("lost execution acknowledgement is unknown and never replayed", async (t) => {
  const fixture = setup(t, ["api"]);
  const original = fixture.fetchImpl;
  let executions = 0;
  fixture.fetchImpl = async (url, options) => {
    if (url.endsWith("/deployment/execute")) {
      executions++;
      throw new Error("Lost response after mutation");
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /unknown/);
  assert.equal(executions, 1);
});

test("a malformed execution response is unknown and never replayed", async (t) => {
  const fixture = setup(t, ["api"]);
  const original = fixture.fetchImpl;
  let executions = 0;
  fixture.fetchImpl = async (url, options) => {
    if (url.endsWith("/deployment/execute")) {
      executions++;
      return new Response("private malformed response");
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /unknown/);
  assert.equal(executions, 1);
});

test("rejected or uncertain execution is never retried", async (t) => {
  for (const status of [400, 408, 409, 429, 500, 502, 504]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    let executions = 0;
    fixture.fetchImpl = async (url, options) => {
      if (url.endsWith("/deployment/execute")) {
        executions++;
        return new Response("private error body", { status });
      }
      return original(url, options);
    };
    await assert.rejects(deployCi(fixture), /unknown/);
    assert.equal(executions, 1);
  }
});

test("an intent acknowledgement for another run or image cannot authorize execution", async (t) => {
  for (const field of ["runId", "app", "digest", "id"]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/intent")) return response;
      const record = await response.json();
      if (field === "digest") record.image.digest = `sha256:${"d".repeat(64)}`;
      else record[field] = "other";
      return Response.json(record);
    };
    await assert.rejects(deployCi(fixture), /Invalid durable intent acknowledgement/);
    assert.equal(
      fixture.calls.some(({ path }) => path === "/deployment/execute"),
      false,
    );
  }
});

test("a duplicate intent with prior mutation evidence cannot replay execution", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  fixture.fetchImpl = async (url, options) =>
    url.endsWith("/intent")
      ? Response.json({
          ...JSON.parse(options.body),
          id: idFor("api"),
          tagWrite: "started",
          queue: null,
        })
      : original(url, options);
  await assert.rejects(deployCi(fixture), /refusing mutation replay/);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/deployment/execute"),
    false,
  );
});

test("execution acknowledgement must match the attempt image and both mutation stages", async (t) => {
  for (const field of ["id", "app", "runId", "digest", "tagWrite", "queue"]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    let executions = 0;
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/deployment/execute")) return response;
      executions++;
      const record = await response.json();
      if (field === "digest") record.image.digest = `sha256:${"c".repeat(64)}`;
      else record[field] = "other";
      return Response.json(record);
    };
    await assert.rejects(deployCi(fixture), /not acknowledged for the intended image/);
    assert.equal(executions, 1);
  }
});

test("web cutover guard prevents execution while the status hostname remains on web", async (t) => {
  const fixture = setup(t, ["web"]);
  const original = fixture.fetchImpl;
  fixture.fetchImpl = async (url, options) =>
    url.includes("/api/domain.byComposeId")
      ? Response.json([{ host: "status.unimatrix-01.dev" }])
      : original(url, options);
  await assert.rejects(deployCi(fixture), /held until/);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/deployment/execute"),
    false,
  );
});

test("disabled, missing, or malformed activation never falls back to uncoordinated deployment", async (t) => {
  for (const value of [undefined, "false", "TRUE", "garbage"]) {
    const fixture = setup(t);
    if (value === undefined) delete fixture.env.DEPLOY_ATTEMPTS_ENABLED;
    else fixture.env.DEPLOY_ATTEMPTS_ENABLED = value;
    delete fixture.env.DEPLOY_REPORT_TOKEN;
    rmSync(join(fixture.root, "publication"), { recursive: true });
    await assert.rejects(deployCi(fixture), /Coordinated deployment execution must be enabled/);
    assert.equal(fixture.calls.length, 0);
  }
});

test("first rollout omits unadvertised fields for the old strict reservation schema", async (t) => {
  const fixture = setup(t, ["api", "deploy"]);
  const original = fixture.fetchImpl;
  let reservations = 0;
  fixture.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({ service: "deploy", status: "ok" });
    if (path === "/deployment/attempts/intent") {
      reservations++;
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, "commitSubject"), false);
      assert.deepEqual(
        Object.keys(body).sort(),
        ["repository", "runId", "runAttempt", "app", "trigger", "image"].sort(),
      );
    }
    return original(url, options);
  };
  await deployCi(fixture);
  assert.equal(reservations, 2);
  assert.deepEqual(
    fixture.calls.filter(({ path }) => path === "/deployment/execute").map(({ body }) => body.app),
    ["api", "deploy"],
  );
});

test("unknown or missing capability headers never authorize optional reservation fields", async (t) => {
  for (const capability of [undefined, "", "commit-subject-v2", "commit-subject-v1-extra", "503"]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    let reservations = 0;
    fixture.fetchImpl = async (url, options) => {
      if (new URL(url).pathname === "/health") {
        return new Response("unused body", {
          status: capability === "503" ? 503 : 200,
          headers: capability === undefined ? {} : { "X-Deploy-Capabilities": capability },
        });
      }
      if (url.endsWith("/intent")) {
        reservations++;
        assert.equal(Object.hasOwn(JSON.parse(options.body), "commitSubject"), false);
      }
      return original(url, options);
    };
    await deployCi(fixture);
    assert.equal(reservations, 1);
  }
});

test("already-current execution is a verified resolved result with no queue", async (t) => {
  for (const mutation of [
    null,
    "acknowledged",
    "container",
    "digest",
    "queue",
    "completion",
    "tag",
    "baseline",
    "stale",
    "deadline",
    "requested",
    "failure",
  ]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    const lines = [];
    fixture.log = (line) => lines.push(line);
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/deployment/execute")) return response;
      const record = await response.json();
      Object.assign(record, {
        outcome: "already-current",
        tagWrite: null,
        queue: null,
        queueClaimedAt: null,
        correlation: "verified",
        landedAt: null,
        lateLandedAt: null,
        baseline: { containerId: "c".repeat(64), observedAt: 1000 },
        after: { containerId: "c".repeat(64), observedAt: 1000, image: record.image },
        completedAt: 1001,
        requestedAt: 1000,
        deadlineAt: 40000,
      });
      if (mutation === "container") record.after.containerId = "d".repeat(64);
      if (mutation === "digest")
        record.after.image = { ...record.image, digest: "sha256:" + "d".repeat(64) };
      if (mutation === "queue") record.queue = "acknowledged";
      if (mutation === "completion") record.completedAt = null;
      if (mutation === "tag") record.tagWrite = "started";
      if (mutation === "acknowledged") record.tagWrite = "acknowledged";
      if (mutation === "baseline") record.baseline.observedAt = 999;
      if (mutation === "stale") record.completedAt = 31000;
      if (mutation === "deadline") record.deadlineAt = 1001;
      if (mutation === "requested") record.requestedAt = 1002;
      if (mutation === "failure") record.failureReason = "Unexpected failure";
      return Response.json(record);
    };
    if (mutation && mutation !== "acknowledged")
      await assert.rejects(deployCi(fixture), /not acknowledged/u);
    else {
      await deployCi(fixture);
      assert.ok(lines.some((line) => line.includes("1 stack(s) already current")));
      assert.equal(
        lines.some((line) => line === "api: deployment queued"),
        false,
      );
    }
  }
});
