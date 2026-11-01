import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SecretValue } from "@unimatrix/secrets/client";
import type { DeployAttemptRecord, DeployRuntimeEvidence } from "@unimatrix/shared";

import { buildApp } from "../src/app.js";
import { openDeploymentAttemptStore } from "../src/attempts/store.js";
import { loadDeployRuntimeConfig } from "../src/config.js";
import { DokployClientError } from "../src/dokploy/transport.js";
import { createImageTagWriter, ImageTagWriteRefused } from "../src/secret-env/image-tag.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

const image = {
  repository: "ghcr.io/unimatrixcore/unimatrix-api",
  tag: "a".repeat(40),
  commit: "a".repeat(40),
  platform: "linux/amd64",
  digestKind: "manifest" as const,
  digest: `sha256:${"b".repeat(64)}`,
};

function fixture(options: { writer?: boolean; queue?: boolean } = {}) {
  const tokens = openServiceTokenStore(":memory:");
  const manage = tokens.issue({ name: "api", capability: "manage" });
  const other = tokens.issue({ name: "other", capability: "manage" });
  const read = tokens.issue({ name: "reader", capability: "read" });
  const attempts = openDeploymentAttemptStore(":memory:");
  const calls: string[] = [];
  let matches = 1;
  let owner = "unimatrixcore";
  let sourceType = "github";
  let readError = false;
  let writeError: Error | undefined;
  let queueError: Error | undefined;
  let evidence: DeployRuntimeEvidence[] = [];
  let selectedApp = "api";
  let written: unknown;
  const app = buildApp(
    loadDeployRuntimeConfig({
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DEPLOY_DATABASE_PATH: ":memory:",
      DOKPLOY_BASE_URL: "http://unused",
      DOKPLOY_API_KEY: "unused",
    }),
    {
      serviceTokens: tokens,
      deploymentAttempts: attempts,
      readRuntimeEvidence: () => Promise.resolve(evidence),
      dokploy: {
        getContainers: () => Promise.resolve([]),
        getDokployVersion: () => Promise.resolve("unused"),
        updateComposeSettings: () => assert.fail("must not write settings"),
        getProjects: () => {
          calls.push("projects");
          if (readError) return Promise.reject(new Error("private-upstream"));
          return Promise.resolve([
            {
              projectId: "p",
              name: "p",
              environments: [
                {
                  environmentId: "e",
                  name: "e",
                  compose: Array.from({ length: matches }, () => ({
                    composeId: `compose-${selectedApp}`,
                    name: selectedApp,
                    composeStatus: "done",
                  })),
                },
              ],
            },
          ]);
        },
        getCompose: () =>
          Promise.resolve({
            composeId: `compose-${selectedApp}`,
            name: selectedApp,
            environmentId: "e",
            composePath: `./infra/docker/${selectedApp}-compose.yaml`,
            sourceType,
            owner,
            repository: "unimatrix-01",
            branch: "main",
            autoDeploy: false,
            env: [],
          }),
      },
      ...(options.writer === false
        ? {}
        : {
            imageTags: {
              write: (composeId, appDir, target) => {
                calls.push("write");
                written = { composeId, appDir, target };
                if (writeError) return Promise.reject(writeError);
                return Promise.resolve();
              },
            },
          }),
      ...(options.queue === false
        ? {}
        : {
            redeployment: {
              queueRedeploy: () => {
                calls.push("queue");
                if (queueError) return Promise.reject(queueError);
                return Promise.resolve();
              },
            },
          }),
    },
  );
  function seed(
    landed = true,
    appDir = "api",
    reporterId = manage.record.id,
    baselineMode: "fresh" | "missing" | "stale" = "fresh",
  ) {
    selectedApp = appDir;
    const now = Date.now() - (baselineMode === "stale" ? 30_001 : 1000);
    const requestedImage = { ...image, repository: `ghcr.io/unimatrixcore/unimatrix-${appDir}` };
    const runtimeImage = {
      repository: requestedImage.repository,
      platform: image.platform,
      digestKind: image.digestKind,
      digest: image.digest,
    };
    const record = attempts.intent(
      {
        repository: "unimatrixcore/unimatrix-01",
        runId: randomUUID().replaceAll(/\D/gu, "").slice(0, 20) || "1",
        runAttempt: 1,
        trigger: "ci",
        app: appDir,
        image: requestedImage,
      },
      reporterId,
      baselineMode === "missing" ? null : { containerId: "c".repeat(64), observedAt: now },
      now,
    );
    if (landed) {
      for (const stage of ["tag-write", "queue"] as const) {
        attempts.report({ attemptId: record.id, stage, result: "started" }, reporterId, now + 1);
        attempts.report(
          { attemptId: record.id, stage, result: "acknowledged" },
          reporterId,
          now + 1,
        );
      }
      attempts.observe(
        [{ app: appDir, containerId: "d".repeat(64), observedAt: now + 2, image: runtimeImage }],
        now + 2,
      );
    }
    evidence = [
      { app: appDir, containerId: "d".repeat(64), observedAt: Date.now(), image: runtimeImage },
    ];
    return record;
  }
  const send = (
    path: "rollback" | "execute",
    payload: object,
    token: string | undefined = manage.token,
  ) =>
    app.inject({
      method: "POST",
      url: `/deployment/${path}`,
      payload,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  return {
    app,
    attempts,
    calls,
    seed,
    send,
    manage,
    other,
    read,
    written: () => written,
    rollback: (targetAttemptId: string) => ({
      app: "api",
      targetAttemptId,
      requestId: randomUUID(),
      actorUserId: "verified-user",
    }),
    setMatches: (value: number) => {
      matches = value;
    },
    setOwner: (value: string) => {
      owner = value;
    },
    setSource: (value: string) => {
      sourceType = value;
    },
    setReadError: () => {
      readError = true;
    },
    setWriteError: (value: Error) => {
      writeError = value;
    },
    setQueueError: (value: Error) => {
      queueError = value;
    },
    setEvidence: (value: DeployRuntimeEvidence[]) => {
      evidence = value;
    },
  };
}

void test("rollback copies a landed immutable image and attributes the verified caller without replay", async () => {
  const f = fixture();
  try {
    const target = f.seed();
    const input = f.rollback(target.id);
    const response = await f.send("rollback", input);
    assert.equal(response.statusCode, 200, response.body);
    const record = response.json<DeployAttemptRecord>();
    assert.equal(record.trigger, "rollback");
    assert.equal(record.targetAttemptId, target.id);
    assert.equal(record.actorUserId, "verified-user");
    assert.equal(record.runId, null);
    assert.deepEqual(record.image, target.image);
    assert.equal(record.queue, "acknowledged");
    assert.equal(record.outcome, "queued");
    assert.deepEqual(f.written(), { composeId: "compose-api", appDir: "api", target: image });
    f.setReadError();
    const retry = await f.send("rollback", input);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<DeployAttemptRecord>().id, record.id);
    assert.deepEqual(f.calls, ["projects", "write", "queue"]);
    assert.equal((await f.send("rollback", f.rollback(target.id))).statusCode, 503);
    assert.equal((await f.send("execute", { app: "api", attemptId: record.id })).statusCode, 409);
  } finally {
    await f.app.close();
  }
});

void test("only manage callers and closed declared app selections can execute rollback", async () => {
  const f = fixture();
  try {
    const input = f.rollback(randomUUID());
    for (const path of ["rollback", "execute"] as const) {
      const payload = path === "rollback" ? input : { app: "api", attemptId: randomUUID() };
      assert.equal(
        (await f.app.inject({ method: "POST", url: `/deployment/${path}`, payload })).statusCode,
        401,
      );
      assert.equal((await f.send(path, payload, f.read.token)).statusCode, 403);
      assert.equal((await f.send(path, { ...payload, composeId: "arbitrary" })).statusCode, 400);
      assert.equal((await f.send(path, { ...payload, app: "absent" })).statusCode, 404);
    }
    assert.equal((await f.send("rollback", { ...input, app: "deploy" })).statusCode, 409);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.app.close();
  }
});

void test("missing or unlanded rollback targets and unavailable mutation capabilities never write", async () => {
  for (const mode of ["missing", "unlanded", "writer", "queue"]) {
    const f = fixture({ writer: mode !== "writer", queue: mode !== "queue" });
    try {
      const target = f.seed(mode !== "unlanded");
      const targetId = mode === "missing" ? randomUUID() : target.id;
      const response = await f.send("rollback", f.rollback(targetId));
      assert.equal(
        response.statusCode,
        mode === "writer" || mode === "queue" ? 503 : 409,
        response.body,
      );
      assert.equal(f.calls.includes("write"), false);
      assert.equal(f.calls.includes("queue"), false);
    } finally {
      await f.app.close();
    }
  }
});

void test("ambiguous, missing, foreign, unsupported and unavailable compose resolution never writes", async () => {
  for (const mode of ["ambiguous", "missing", "foreign", "source", "read-error"]) {
    const f = fixture();
    try {
      const target = f.seed();
      if (mode === "ambiguous") f.setMatches(2);
      if (mode === "missing") f.setMatches(0);
      if (mode === "foreign") f.setOwner("foreign");
      if (mode === "source") f.setSource("git");
      if (mode === "read-error") f.setReadError();
      const response = await f.send("rollback", f.rollback(target.id));
      assert.equal(response.statusCode, mode === "read-error" ? 503 : 409, response.body);
      assert.doesNotMatch(response.body, /private-upstream/);
      assert.equal(f.calls.includes("write"), false);
    } finally {
      await f.app.close();
    }
  }
});

void test("tag failures never queue and neither uncertain nor rejected operations are retried", async () => {
  for (const error of [
    new ImageTagWriteRefused(),
    new DokployClientError("private", 400),
    new DokployClientError("private", 408),
    new DokployClientError("private", 429),
    new DokployClientError("private", 500),
    new Error("private"),
  ]) {
    const f = fixture();
    try {
      const target = f.seed();
      f.setWriteError(error);
      const input = f.rollback(target.id);
      const response = await f.send("rollback", input);
      assert.equal(response.statusCode, 200, response.body);
      const result =
        error instanceof ImageTagWriteRefused ||
        (error instanceof DokployClientError && error.status === 400)
          ? "rejected"
          : "unknown";
      assert.equal(response.json<DeployAttemptRecord>().tagWrite, result);
      assert.equal(response.json<DeployAttemptRecord>().queue, null);
      assert.doesNotMatch(response.body, /private/);
      await f.send("rollback", input);
      assert.deepEqual(f.calls, ["projects", "write"]);
    } finally {
      await f.app.close();
    }
  }
});

void test("queue uncertainty is durable without requeueing and CI execute has the same service scope", async () => {
  for (const error of [undefined, new DokployClientError("private", 400), new Error("private")]) {
    const f = fixture();
    try {
      const target = f.seed(false);
      if (error) f.setQueueError(error);
      const input = { app: "api", attemptId: target.id };
      const response = await f.send("execute", input);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        response.json<DeployAttemptRecord>().queue,
        error === undefined
          ? "acknowledged"
          : error instanceof DokployClientError
            ? "rejected"
            : "unknown",
      );
      f.setReadError();
      assert.equal((await f.send("execute", input)).statusCode, 200);
      assert.deepEqual(f.calls, ["projects", "write", "queue"]);
      assert.equal((await f.send("execute", input, f.other.token)).statusCode, 409);
    } finally {
      await f.app.close();
    }
  }
});

void test("CI execution permits self and refuses absent attempt or missing capability", async () => {
  for (const mode of ["self", "missing", "capability"]) {
    const f = fixture({ writer: mode !== "capability" });
    try {
      const target = f.seed(false, mode === "self" ? "deploy" : "api");
      const response = await f.send("execute", {
        app: target.app,
        attemptId: mode === "missing" ? randomUUID() : target.id,
      });
      assert.equal(
        response.statusCode,
        mode === "self" ? 200 : mode === "missing" ? 404 : 503,
        response.body,
      );
    } finally {
      await f.app.close();
    }
  }
});

void test("image-tag writes preserve unrelated env bytes and pin the manifest digest", async () => {
  let blob = "# header\r\nTOKEN='private value'\r\nIMAGE_TAG=${{project.IMAGE_TAG}}\r\nOTHER=keep";
  let writes = 0;
  const writer = createImageTagWriter({
    getComposeEnv: () =>
      Promise.resolve({
        composeId: "compose-api",
        owner: "unimatrixcore",
        repository: "unimatrix-01",
        sourceType: "github",
        env: new SecretValue(blob),
      }),
    updateComposeEnv: (id, env) => {
      assert.equal(id, "compose-api");
      blob = env.reveal();
      writes++;
      return Promise.resolve();
    },
  });
  await writer.write("compose-api", "api", image);
  assert.equal(
    blob,
    `# header\r\nTOKEN='private value'\r\nIMAGE_TAG=${image.tag}@${image.digest}\r\nOTHER=keep`,
  );
  await writer.write("compose-api", "api", image);
  assert.equal(writes, 1);
});

void test("image-tag writes refuse unsupported env, duplicate tag, mismatched identity and image", async () => {
  for (const mode of [
    "duplicate",
    "multiline",
    "owner",
    "repository",
    "source",
    "id",
    "image",
    "invalid-image",
  ]) {
    const writer = createImageTagWriter({
      getComposeEnv: () =>
        Promise.resolve({
          composeId: mode === "id" ? "foreign" : "compose-api",
          owner: mode === "owner" ? "foreign" : "unimatrixcore",
          repository: mode === "repository" ? "foreign" : "unimatrix-01",
          sourceType: mode === "source" ? "git" : "github",
          env: new SecretValue(
            mode === "duplicate"
              ? "IMAGE_TAG=one\nIMAGE_TAG=two\n"
              : mode === "multiline"
                ? "TOKEN='private\nvalue'\n"
                : "TOKEN=private\n",
          ),
        }),
      updateComposeEnv: () => assert.fail("must not mutate ambiguous env"),
    });
    await assert.rejects(
      writer.write(
        "compose-api",
        "api",
        mode === "image"
          ? { ...image, repository: "ghcr.io/foreign/api" }
          : mode === "invalid-image"
            ? { ...image, digest: "invalid" }
            : image,
      ),
      ImageTagWriteRefused,
    );
  }
});

void test("a successful env mutation must read back the intended image before queueing is permitted", async () => {
  let writes = 0;
  const writer = createImageTagWriter({
    getComposeEnv: () =>
      Promise.resolve({
        composeId: "compose-api",
        owner: "unimatrixcore",
        repository: "unimatrix-01",
        sourceType: "github",
        env: new SecretValue("IMAGE_TAG=old\nTOKEN=private\n"),
      }),
    updateComposeEnv: () => {
      writes++;
      return Promise.resolve();
    },
  });
  await assert.rejects(writer.write("compose-api", "api", image), /could not be confirmed/u);
  assert.equal(writes, 1);
});

void test("concurrent duplicate CI execution claims submit only one tag mutation and queue", async () => {
  const f = fixture();
  try {
    const target = f.seed(false);
    const input = { app: "api", attemptId: target.id };
    const responses = await Promise.all([f.send("execute", input), f.send("execute", input)]);
    for (const response of responses) assert.equal(response.statusCode, 200, response.body);
    assert.equal(f.calls.filter((value) => value === "write").length, 1);
    assert.equal(f.calls.filter((value) => value === "queue").length, 1);
  } finally {
    await f.app.close();
  }
});

void test("the next CI deployment supersedes a landed service rollback with its newly published image", async () => {
  const f = fixture();
  try {
    const target = f.seed();
    const response = await f.send("rollback", f.rollback(target.id));
    assert.equal(response.statusCode, 200, response.body);
    const record = response.json<DeployAttemptRecord>();
    const now = Date.now();
    f.attempts.observe(
      [
        {
          app: "api",
          containerId: "e".repeat(64),
          observedAt: now,
          image: {
            repository: image.repository,
            platform: image.platform,
            digestKind: image.digestKind,
            digest: image.digest,
          },
        },
      ],
      now,
    );
    assert.equal(f.attempts.get("api", record.id, now)?.outcome, "landed");
    const nextImage = {
      ...image,
      tag: "f".repeat(40),
      commit: "f".repeat(40),
      digest: `sha256:${"f".repeat(64)}`,
    };
    const next = f.attempts.intent(
      {
        repository: "unimatrixcore/unimatrix-01",
        app: "api",
        runId: "999999",
        runAttempt: 1,
        trigger: "ci",
        image: nextImage,
      },
      f.manage.record.id,
      { containerId: "e".repeat(64), observedAt: now },
      now,
    );
    const deployed = await f.send("execute", { app: "api", attemptId: next.id });
    assert.equal(deployed.statusCode, 200, deployed.body);
    assert.equal(deployed.json<DeployAttemptRecord>().queue, "acknowledged");
    assert.deepEqual(f.written(), { composeId: "compose-api", appDir: "api", target: nextImage });
  } finally {
    await f.app.close();
  }
});

void test("CI execution refreshes missing or stale intent baselines before claiming each app", async () => {
  for (const mode of ["missing", "stale"] as const) {
    const f = fixture();
    try {
      const target = f.seed(false, "api", f.manage.record.id, mode);
      const response = await f.send("execute", { app: "api", attemptId: target.id });
      assert.equal(response.statusCode, 200, response.body);
      const claimed = f.attempts.get("api", target.id, Date.now())!;
      assert.equal(claimed.tagWrite, "acknowledged");
      assert.equal(claimed.baseline?.containerId, "d".repeat(64));
      assert.ok(claimed.baseline.observedAt > target.requestedAt);
      assert.equal(claimed.queue, "acknowledged");
      f.setEvidence([]);
      assert.equal((await f.send("execute", { app: "api", attemptId: target.id })).statusCode, 200);
      assert.equal(f.calls.filter((entry) => entry === "write").length, 1);
      assert.equal(f.calls.filter((entry) => entry === "queue").length, 1);
    } finally {
      await f.app.close();
    }
  }
});

void test("rollback refuses missing, stale or ambiguous bridge baseline before reservation", async () => {
  for (const mode of ["missing", "stale", "ambiguous"] as const) {
    const f = fixture();
    try {
      const target = f.seed();
      const evidence = {
        app: "api",
        containerId: "d".repeat(64),
        observedAt: Date.now() - (mode === "stale" ? 30_001 : 0),
        image: {
          repository: image.repository,
          platform: image.platform,
          digestKind: image.digestKind,
          digest: image.digest,
        },
      };
      f.setEvidence(
        mode === "missing" ? [] : mode === "ambiguous" ? [evidence, evidence] : [evidence],
      );
      const response = await f.send("rollback", f.rollback(target.id));
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(f.attempts.list("api", 100, Date.now()).length, 1);
      assert.equal(f.calls.includes("write"), false);
      assert.equal(f.calls.includes("queue"), false);
    } finally {
      await f.app.close();
    }
  }
});

void test("CI execution refuses missing, stale, future or ambiguous current evidence without claiming", async () => {
  for (const mode of ["missing", "stale", "future", "ambiguous"] as const) {
    const f = fixture();
    try {
      const target = f.seed(false);
      const evidence = {
        app: "api",
        containerId: "e".repeat(64),
        observedAt: Date.now() + (mode === "future" ? 60_000 : mode === "stale" ? -30_001 : 0),
        image,
      };
      f.setEvidence(
        mode === "missing" ? [] : mode === "ambiguous" ? [evidence, evidence] : [evidence],
      );
      const response = await f.send("execute", { app: "api", attemptId: target.id });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(f.attempts.get("api", target.id, Date.now())!.tagWrite, null);
      assert.deepEqual(f.attempts.get("api", target.id, Date.now())!.baseline, target.baseline);
      assert.equal(f.calls.includes("write"), false);
      assert.equal(f.calls.includes("queue"), false);
    } finally {
      await f.app.close();
    }
  }
});

void test("a rejected post-write readback stays unknown and retains the app reservation", async () => {
  const f = fixture();
  try {
    const target = f.seed(false);
    let reads = 0;
    let writes = 0;
    f.app.imageTags = createImageTagWriter({
      getComposeEnv: () => {
        if (reads++ > 0) return Promise.reject(new DokployClientError("private-readback", 403));
        return Promise.resolve({
          composeId: "compose-api",
          owner: "unimatrixcore",
          repository: "unimatrix-01",
          sourceType: "github",
          env: new SecretValue("IMAGE_TAG=old\nTOKEN=private\n"),
        });
      },
      updateComposeEnv: () => {
        writes++;
        return Promise.resolve();
      },
    });
    const input = { app: "api", attemptId: target.id };
    const response = await f.send("execute", input);
    assert.equal(response.statusCode, 200, response.body);
    const record = response.json<DeployAttemptRecord>();
    assert.equal(writes, 1);
    assert.equal(record.tagWrite, "unknown");
    assert.equal(record.outcome, "incomplete");
    assert.equal(record.queue, null);
    assert.equal(f.calls.includes("queue"), false);
    assert.doesNotMatch(response.body, /private/u);
    const retry = await f.send("execute", input);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    const now = Date.now();
    assert.throws(
      () =>
        f.attempts.intent(
          {
            repository: "unimatrixcore/unimatrix-01",
            runId: "987654321",
            runAttempt: 1,
            app: "api",
            trigger: "ci",
            image,
          },
          f.manage.record.id,
          { containerId: "d".repeat(64), observedAt: now },
          now,
        ),
      /conflicts/u,
    );
  } finally {
    await f.app.close();
  }
});

void test("rollback retries resume unclaimed reservations after bridge recovery without replaying mutations", async () => {
  const f = fixture();
  try {
    const target = f.seed();
    const input = f.rollback(target.id);
    const originalRead = f.app.readRuntimeEvidence;
    let reads = 0;
    f.app.readRuntimeEvidence = () => {
      if (++reads === 2) return Promise.reject(new Error("private-bridge-failure"));
      return originalRead();
    };
    const failed = await f.send("rollback", input);
    assert.equal(failed.statusCode, 503, failed.body);
    assert.doesNotMatch(failed.body, /private/u);
    const reserved = f.attempts.findRollback(input, f.manage.record.id, Date.now())!;
    assert.equal(reserved.tagWrite, null);
    assert.equal(reserved.queue, null);
    assert.equal(f.calls.includes("write"), false);
    assert.equal(f.calls.includes("queue"), false);
    const resumed = await Promise.all([f.send("rollback", input), f.send("rollback", input)]);
    for (const response of resumed) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json<DeployAttemptRecord>().id, reserved.id);
    }
    const completed = f.attempts.get("api", reserved.id, Date.now())!;
    assert.equal(completed.tagWrite, "acknowledged");
    assert.equal(completed.queue, "acknowledged");
    assert.equal(f.calls.filter((entry) => entry === "write").length, 1);
    assert.equal(f.calls.filter((entry) => entry === "queue").length, 1);
    f.setReadError();
    f.setEvidence([]);
    const retry = await f.send("rollback", input);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<DeployAttemptRecord>().id, reserved.id);
    assert.equal(f.calls.filter((entry) => entry === "write").length, 1);
    assert.equal(f.calls.filter((entry) => entry === "queue").length, 1);
  } finally {
    await f.app.close();
  }
});
