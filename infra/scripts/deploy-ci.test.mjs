import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
    if (path === "/deployment/attempts/intent") {
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.headers.Authorization, "Bearer private-token");
      const state = { ...body, id: idFor(body.app), tagWrite: null, queue: null };
      states.set(state.id, state);
      return Response.json(state);
    }
    if (path === "/deployment/attempts/report") {
      const state = states.get(body.attemptId);
      state[body.stage === "tag-write" ? "tagWrite" : "queue"] = body.result;
      return Response.json(state);
    }
    if (path === "/api/domain.byComposeId") return Response.json([]);
    if (path === "/api/project.update" || path === "/api/compose.deploy") {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers["x-api-key"], "private-key");
      // A mutation's success payload may contain secrets and must not be parsed.
      return new Response("unparseable private env payload");
    }
    throw new Error("Unexpected request");
  }
  return { root, env, calls, fetchImpl, log: () => undefined };
}

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

test("acknowledges every durable intent and claim before a shared project mutation", async (t) => {
  const fixture = setup(t);
  await deployCi(fixture);
  const { calls } = fixture;
  const mutationIndex = calls.findIndex(({ path }) => path === "/api/project.update");
  assert.equal(
    calls.slice(0, mutationIndex).filter(({ path }) => path.endsWith("/intent")).length,
    2,
  );
  assert.equal(
    calls.slice(0, mutationIndex).filter(({ body }) => body?.result === "started").length,
    2,
  );
  assert.equal(calls.filter(({ path }) => path === "/api/project.update").length, 1);
  assert.equal(calls.filter(({ path }) => path === "/api/compose.deploy").length, 2);
  for (const app of ["api", "auth"]) {
    const queueIndex = calls.findIndex(
      ({ path, body }) => path === "/api/compose.deploy" && body.composeId === `compose-${app}`,
    );
    assert.equal(calls[queueIndex].body.title, `unimatrix-attempt:${idFor(app)}`);
    assert.deepEqual(calls[queueIndex - 1].body, {
      attemptId: idFor(app),
      stage: "queue",
      result: "started",
    });
    assert.deepEqual(calls[queueIndex + 1].body, {
      attemptId: idFor(app),
      stage: "queue",
      result: "acknowledged",
    });
  }
});

test("an unavailable intent prevents all mutations and retries reporting only", async (t) => {
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
    fixture.calls.some(
      ({ path }) => path === "/api/project.update" || path === "/api/compose.deploy",
    ),
    false,
  );
});

test("missing publication or reporting configuration fails before deployment discovery or writes", async (t) => {
  for (const missing of ["DEPLOY_REPORT_TOKEN", "DEPLOY_REPORT_URL"]) {
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

test("uncertain mutation claim is never retried and prevents the mutation", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  let claims = 0;
  fixture.fetchImpl = async (url, options) => {
    if (JSON.parse(options.body ?? "null")?.result === "started") {
      claims++;
      throw new Error("Connection lost after persistence");
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /Durable deployment report unavailable/);
  assert.equal(claims, 1);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/api/project.update"),
    false,
  );
});

test("transport failure after tag mutation records unknown and never replays or queues", async (t) => {
  const fixture = setup(t);
  const original = fixture.fetchImpl;
  let writes = 0;
  fixture.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/project.update")) {
      writes++;
      throw new Error("Response lost");
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /unknown/);
  assert.equal(writes, 1);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/api/compose.deploy"),
    false,
  );
  assert.equal(
    fixture.calls.filter(({ body }) => body?.stage === "tag-write" && body.result === "unknown")
      .length,
    2,
  );
});

test("transport failure after queue submission is unknown and never retried", async (t) => {
  const fixture = setup(t, ["api"]);
  const original = fixture.fetchImpl;
  let queues = 0;
  fixture.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/compose.deploy")) {
      queues++;
      throw new Error("Response lost");
    }
    return original(url, options);
  };
  await assert.rejects(deployCi(fixture), /unknown/);
  assert.equal(queues, 1);
  assert.deepEqual(fixture.calls.at(-1).body, {
    attemptId: idFor("api"),
    stage: "queue",
    result: "unknown",
  });
});

test("proxy failures after a mutation remain unknown rather than definite rejection", async (t) => {
  for (const status of [408, 500, 502, 504]) {
    const fixture = setup(t, ["api"]);
    const original = fixture.fetchImpl;
    let mutations = 0;
    fixture.fetchImpl = async (url, options) => {
      if (url.endsWith("/api/compose.deploy")) {
        mutations++;
        return new Response("private error body", { status });
      }
      return original(url, options);
    };
    await assert.rejects(deployCi(fixture), /unknown/);
    assert.equal(mutations, 1);
    assert.deepEqual(fixture.calls.at(-1).body, {
      attemptId: idFor("api"),
      stage: "queue",
      result: "unknown",
    });
  }
});

test("an acknowledgement for another run or image cannot authorize mutations", async (t) => {
  for (const field of ["runId", "app", "digest"]) {
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
      fixture.calls.some(({ path }) => path === "/api/project.update"),
      false,
    );
  }
});

test("lost terminal callback is retried without replaying the acknowledged mutation", async (t) => {
  const fixture = setup(t, ["api"]);
  const original = fixture.fetchImpl;
  let callbackCalls = 0;
  fixture.fetchImpl = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (body?.stage === "queue" && body.result === "acknowledged" && callbackCalls++ === 0)
      throw new Error("Lost callback acknowledgement");
    return original(url, options);
  };
  await deployCi(fixture);
  assert.equal(callbackCalls, 2);
  assert.equal(fixture.calls.filter(({ path }) => path === "/api/compose.deploy").length, 1);
});

test("a duplicate intent with previous mutation evidence cannot replay a deployment", async (t) => {
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
    fixture.calls.some(({ path }) => path === "/api/project.update"),
    false,
  );
});

test("web cutover guard retains tag-write acknowledgement without inventing queued work", async (t) => {
  const fixture = setup(t, ["web"]);
  const original = fixture.fetchImpl;
  fixture.fetchImpl = async (url, options) =>
    url.includes("/api/domain.byComposeId")
      ? Response.json([{ host: "status.unimatrix-01.dev" }])
      : original(url, options);
  await assert.rejects(deployCi(fixture), /held until/);
  assert.equal(
    fixture.calls.some(({ path }) => path === "/api/compose.deploy"),
    false,
  );
  assert.equal(
    fixture.calls.some(({ body }) => body?.stage === "queue"),
    false,
  );
});

test("disabled activation preserves orchestration without sending attempt traffic", async (t) => {
  const fixture = setup(t);
  fixture.env.DEPLOY_ATTEMPTS_ENABLED = "false";
  delete fixture.env.DEPLOY_REPORT_TOKEN;
  rmSync(join(fixture.root, "publication"), { recursive: true });
  await deployCi(fixture);
  assert.equal(
    fixture.calls.some(({ path }) => path.startsWith("/deployment/")),
    false,
  );
  assert.equal(fixture.calls.filter(({ path }) => path === "/api/compose.deploy").length, 2);
});
