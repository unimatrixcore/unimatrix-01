import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { deployCi } from "./deploy-ci.mjs";
import { publicationFromPush, publishImage } from "./publish-image.mjs";
import { createDeploymentPlan } from "./deploy-plan.mjs";

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
    mkdirSync(join(root, "apps", app), { recursive: true });
    writeFileSync(join(root, "apps", app, "Dockerfile"), "FROM scratch\n");
    writeFileSync(
      join(root, "apps", app, "package.json"),
      JSON.stringify({ name: `@unimatrix/${app}` }),
    );
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
    DEPLOY_PLAN_PATH: "deployment-plan.json",
  };
  writeFileSync(
    join(root, env.DEPLOY_PLAN_PATH),
    JSON.stringify(createDeploymentPlan({ root, env })),
  );
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
          environments: [
            {
              compose: apps.map((name) => ({
                name,
                composeId: `compose-${name}`,
              })),
            },
          ],
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
      assert.deepEqual(Object.keys(body), ["intents"]);
      const attempts = body.intents.map((intent) => {
        const prior = states.get(idFor(intent.app));
        if (prior !== undefined) return prior;
        const state = {
          ...intent,
          id: idFor(intent.app),
          tagWrite: null,
          queue: null,
          queueClaimedAt: null,
          outcome: "incomplete",
          correlation: "pending",
          after: null,
          landedAt: null,
          lateLandedAt: null,
          recreatedAt: null,
          completedAt: null,
          failureReason: null,
          requestedAt: Date.now(),
          deadlineAt: Date.now() + 1_800_000,
        };
        states.set(state.id, state);
        return state;
      });
      return Response.json({ attempts });
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
  writeFileSync(
    join(fixture.root, fixture.env.DEPLOY_PLAN_PATH),
    JSON.stringify(createDeploymentPlan({ root: fixture.root, env: fixture.env })),
  );
  const path = join(fixture.root, "publication/api.json");
  const publication = JSON.parse(readFileSync(path, "utf8"));
  publication.image.tag = revision;
  publication.image.commit = revision;
  writeFileSync(path, JSON.stringify(publication));
  await deployCi(fixture);
  assert.equal(
    fixture.calls.find(({ path: route }) => route === "/deployment/attempts/intent").body.intents[0]
      .commitSubject,
    "feat: deploy $(private) `literal` subject",
  );
});

test("captures the digest returned by that publication, refusing missing or ambiguous push evidence", () => {
  const image = {
    repository: "ghcr.io/unimatrixcore/unimatrix-api",
    tag: commit,
    app: "api",
  };
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
        {
          IMAGE: "ghcr.io/unimatrixcore/unimatrix-api",
          REVISION: commit,
          APP: "api",
        },
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
    1,
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

function scopedFixture(t, changedApp) {
  const fixture = setup(t);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: fixture.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git(["init"]);
  git(["add", "apps", "infra"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "baseline"]);
  const base = git(["rev-parse", "HEAD"]);
  if (changedApp) {
    writeFileSync(join(fixture.root, "apps", changedApp, "index.ts"), "changed\n");
    git(["add", "apps"]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-m",
      "app change",
    ]);
  }
  fixture.env.IMAGE_TAG = git(["rev-parse", "HEAD"]);
  const baselines = new Map(
    ["api", "auth"].map((app) => [
      app,
      {
        commit: base,
        containerId: "c".repeat(64),
        observedAt: Date.now(),
        image: {
          repository: `ghcr.io/unimatrixcore/unimatrix-${app}`,
          platform: "linux/amd64",
          digestKind: "manifest",
          digest,
        },
      },
    ]),
  );
  writeFileSync(
    join(fixture.root, fixture.env.DEPLOY_PLAN_PATH),
    JSON.stringify(createDeploymentPlan({ root: fixture.root, env: fixture.env, baselines })),
  );
  rmSync(join(fixture.root, "publication"), { recursive: true });
  if (changedApp) {
    mkdirSync(join(fixture.root, "publication"));
    writeFileSync(
      join(fixture.root, "publication", `${changedApp}.json`),
      JSON.stringify({
        app: changedApp,
        image: {
          ...baselines.get(changedApp).image,
          tag: fixture.env.IMAGE_TAG,
          commit: fixture.env.IMAGE_TAG,
        },
      }),
    );
  }
  const originalFetch = fixture.fetchImpl;
  fixture.fetchImpl = (url, options) => {
    if (new URL(url).pathname !== "/deployment/baselines") return originalFetch(url, options);
    const checkedAt = Date.now();
    return Response.json({
      checkedAt,
      apps: [...baselines].map(([app, baseline]) => ({
        app,
        baseline: { ...baseline, observedAt: checkedAt },
      })),
    });
  };
  return { ...fixture, baselines };
}

test("affected plan reserves and executes only selected services without other publications", async (t) => {
  const fixture = scopedFixture(t, "api");
  await deployCi(fixture);
  assert.deepEqual(
    fixture.calls.find(({ path }) => path.endsWith("/intent")).body.intents.map(({ app }) => app),
    ["api"],
  );
  assert.deepEqual(
    fixture.calls.filter(({ path }) => path === "/deployment/execute").map(({ body }) => body.app),
    ["api"],
  );
});

test("an empty affected plan makes no discovery, reservations or writes and needs no publications", async (t) => {
  const fixture = scopedFixture(t, null);
  const messages = [];
  await deployCi({ ...fixture, log: (message) => messages.push(message) });
  assert.deepEqual(fixture.calls, []);
  assert.match(messages[0], /No affected services/u);
});

test("a skipped service changed during publication blocks every deployment mutation", async (t) => {
  const fixture = scopedFixture(t, "api");
  fixture.baselines.set("auth", { ...fixture.baselines.get("auth"), commit: "d".repeat(40) });
  await assert.rejects(deployCi(fixture), /changed after planning/u);
  assert.deepEqual(fixture.calls, []);
});

test("missing or altered deployment plans cannot authorize writes", async (t) => {
  const fixture = setup(t);
  rmSync(join(fixture.root, fixture.env.DEPLOY_PLAN_PATH));
  await assert.rejects(deployCi(fixture));
  assert.deepEqual(fixture.calls, []);
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
  for (const field of [
    "repository",
    "runId",
    "runAttempt",
    "app",
    "trigger",
    "id",
    "commitSubject",
    "tag",
    "commit",
    "platform",
    "digestKind",
    "digest",
  ]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/intent")) return response;
      const batch = await response.json();
      const record = batch.attempts[0];
      if (["tag", "commit", "platform", "digestKind", "digest"].includes(field))
        record.image[field] = "other";
      else record[field] = "other";
      return Response.json(batch);
    };
    await assert.rejects(deployCi(fixture), /Invalid durable intent acknowledgement/);
    assert.equal(
      fixture.calls.some(({ path }) => path === "/deployment/execute"),
      false,
    );
  }
});

test("a batch containing prior mutation evidence cannot replay any execution", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  fixture.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    if (!url.endsWith("/intent")) return response;
    const batch = await response.json();
    batch.attempts.at(-1).tagWrite = "started";
    return Response.json(batch);
  };
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

test("batch intents omit unadvertised optional commit-subject fields", async (t) => {
  const fixture = setup(t, ["api", "deploy"]);
  const original = fixture.fetchImpl;
  let reservations = 0;
  fixture.fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({ service: "deploy", status: "ok" });
    if (path === "/deployment/attempts/intent") {
      reservations++;
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body), ["intents"]);
      for (const intent of body.intents) {
        assert.equal(Object.hasOwn(intent, "commitSubject"), false);
        assert.deepEqual(
          Object.keys(intent).sort(),
          ["repository", "runId", "runAttempt", "app", "trigger", "image"].sort(),
        );
      }
    }
    return original(url, options);
  };
  await deployCi(fixture);
  assert.equal(reservations, 1);
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
        assert.equal(Object.hasOwn(JSON.parse(options.body).intents[0], "commitSubject"), false);
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
        after: {
          containerId: "c".repeat(64),
          observedAt: 1000,
          image: record.image,
        },
        completedAt: 1001,
        requestedAt: 1000,
        deadlineAt: 40000,
      });
      if (mutation === "container") record.after.containerId = "d".repeat(64);
      if (mutation === "digest")
        record.after.image = {
          ...record.image,
          digest: "sha256:" + "d".repeat(64),
        };
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

test("a conflict on the final app is one batch request with no per-app fallback or execution", async (t) => {
  const fixture = setup(t, ["api", "auth", "web"]);
  const original = fixture.fetchImpl;
  const reservations = [];
  fixture.fetchImpl = async (url, options) => {
    if (url.endsWith("/intent")) {
      const body = JSON.parse(options.body);
      reservations.push(body);
      assert.deepEqual(
        body.intents.map((intent) => intent.app),
        ["api", "auth", "web"],
      );
      return new Response("private final-app conflict", { status: 409 });
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /Durable deployment report unavailable/);
  assert.equal(reservations.length, 1);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/deployment/execute"),
    false,
  );
});

test("an old server rejecting the batch never triggers single-intent fallback", async (t) => {
  for (const status of [400, 404]) {
    const fixture = setup(t);
    const original = fixture.fetchImpl;
    const reservations = [];
    fixture.fetchImpl = async (url, options) => {
      if (url.endsWith("/intent")) {
        reservations.push(JSON.parse(options.body));
        return new Response("unsupported body", { status });
      }
      return original(url, options);
    };
    await assert.rejects(deployCi(fixture), /Durable deployment report unavailable/);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].intents.length, 2);
    assert.equal(
      fixture.calls.some(({ path }) => path === "/deployment/execute"),
      false,
    );
  }
});

test("a lost batch acknowledgement retries only the identical release before execution", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  const bodies = [];
  let originalIds;
  fixture.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    if (!url.endsWith("/intent")) return response;
    bodies.push(options.body);
    const batch = await response.json();
    if (bodies.length === 1) {
      originalIds = batch.attempts.map(({ id }) => id);
      throw new Error("Lost acknowledgement after reservation committed");
    }
    assert.deepEqual(
      batch.attempts.map(({ id }) => id),
      originalIds,
    );
    return Response.json(batch);
  };
  await deployCi(fixture);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  const executions = fixture.calls.filter(({ path }) => path === "/deployment/execute");
  assert.deepEqual(
    executions.map(({ body }) => body.attemptId),
    originalIds,
  );
  assert.equal(
    fixture.calls.findIndex(({ path }) => path === "/deployment/execute"),
    4,
  );
});

test("malformed batch acknowledgements cannot authorize even the first execution", async (t) => {
  for (const mutation of [
    "null",
    "missing",
    "empty",
    "short",
    "extra",
    "duplicate-app",
    "duplicate-id",
    "unknown-app",
    "single",
    "extra-key",
    "null-record",
  ]) {
    const fixture = setup(t);
    const original = fixture.fetchImpl;
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/intent")) return response;
      let batch = await response.json();
      if (mutation === "null") batch = null;
      if (mutation === "missing") batch = {};
      if (mutation === "empty") batch.attempts = [];
      if (mutation === "short") batch.attempts.pop();
      if (mutation === "extra") batch.attempts.push({ ...batch.attempts[0] });
      if (mutation === "duplicate-app") batch.attempts[1] = { ...batch.attempts[0] };
      if (mutation === "duplicate-id") batch.attempts[1].id = batch.attempts[0].id;
      if (mutation === "unknown-app") batch.attempts[1].app = "web";
      if (mutation === "single") batch = batch.attempts[0];
      if (mutation === "extra-key") batch.unexpected = true;
      if (mutation === "null-record") batch.attempts[1] = null;
      return Response.json(batch);
    };
    await assert.rejects(deployCi(fixture), /Invalid durable intent acknowledgement/);
    assert.equal(
      fixture.calls.some(({ path }) => path === "/deployment/execute"),
      false,
    );
  }
});

test("every returned reservation must be unused and eligible before any execution", async (t) => {
  const mutations = [
    ["outcome", "failed"],
    ["correlation", "verified"],
    ["tagWrite", "started"],
    ["tagWrite", "unknown"],
    ["tagWrite", "acknowledged"],
    ["queue", "started"],
    ["queue", "unknown"],
    ["queue", "acknowledged"],
    ["queueClaimedAt", 1000],
    ["after", {}],
    ["landedAt", 1000],
    ["lateLandedAt", 1000],
    ["recreatedAt", 1000],
    ["completedAt", 1000],
    ["failureReason", "failure"],
    ["requestedAt", -1],
    ["requestedAt", 0.5],
    ["deadlineAt", Date.now() - 1],
    ["deadlineAt", null],
  ];
  for (const [field, value] of mutations) {
    const fixture = setup(t);
    const original = fixture.fetchImpl;
    fixture.fetchImpl = async (url, options) => {
      const response = await original(url, options);
      if (!url.endsWith("/intent")) return response;
      const batch = await response.json();
      batch.attempts.at(-1)[field] = value;
      return Response.json(batch);
    };
    await assert.rejects(deployCi(fixture), /refusing mutation replay/);
    assert.equal(
      fixture.calls.some(({ path }) => path === "/deployment/execute"),
      false,
    );
  }
});
