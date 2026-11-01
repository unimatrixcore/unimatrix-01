import assert from "node:assert/strict";
import test from "node:test";

import type { DeployDesiredState } from "@unimatrix/deploy-config";
import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import type { DokployContainer } from "../src/dokploy/schemas.js";
import { createContainerObserver } from "../src/observe/observer.js";

const desired: DeployDesiredState = [
  {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-api",
    containerPort: 3001,
    env: [],
    buildArgNames: [],
    publicStatus: true,
    healthProbe: { url: "http://web:8080/" },
  },
  {
    appDir: "web",
    packageName: "@unimatrix/web",
    kind: "static-spa",
    composePath: "infra/docker/web-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-web",
    containerPort: 8080,
    env: [],
    buildArgNames: [],
    publicStatus: true,
    healthProbe: { url: "http://web:8080/" },
  },
];

function container(overrides: Partial<DokployContainer> = {}): DokployContainer {
  return {
    containerId: "first",
    name: "unrelated-generated-name",
    image: "ghcr.io/unimatrixcore/unimatrix-api:old-tag",
    ports: "3001/tcp",
    state: "running",
    status: "Up 2 hours",
    ...overrides,
  };
}

void test("matches the declared image repository and keeps age distinct from coarse status", async () => {
  let time = 100;
  const observer = createContainerObserver(
    { getContainers: () => Promise.resolve([container()]) },
    desired,
    () => time,
  );

  assert.deepEqual(observer.getSnapshot(), [
    { appDir: "api", kind: "unknown", reason: "not-polled", observedAt: null },
    { appDir: "web", kind: "unknown", reason: "not-polled", observedAt: null },
  ]);

  const first = await observer.poll();
  assert.deepEqual(first[0], {
    appDir: "api",
    kind: "matched",
    observedAt: 100,
    containerId: "first",
    image: "ghcr.io/unimatrixcore/unimatrix-api:old-tag",
    state: "running",
    status: "Up 2 hours",
    containerAgeMs: null,
    name: "unrelated-generated-name",
    startedAt: null,
    health: null,
    imageTag: "old-tag",
    commit: null,
    commitSubject: null,
    runtimeMetadataObservedAt: null,
    firstObservedAt: 100,
    lastRecreatedAt: null,
  });
  assert.deepEqual(first[1], {
    appDir: "web",
    kind: "unknown",
    reason: "no-match",
    observedAt: 100,
  });

  time = 200;
  const second = await observer.poll();
  assert.equal(second[0]?.kind, "matched");
  if (second[0]?.kind === "matched") {
    assert.equal(second[0].firstObservedAt, 100);
    assert.equal(second[0].lastRecreatedAt, null);
  }
});

void test("a changed ID is recreation; a changed status on the same ID is not", async () => {
  let time = 100;
  let current = container();
  const observer = createContainerObserver(
    { getContainers: () => Promise.resolve([current]) },
    desired.slice(0, 1),
    () => time,
  );
  await observer.poll();

  time = 200;
  current = container({ state: "restarting", status: "Restarting (1) 2 seconds ago" });
  let observed = await observer.poll();
  assert.equal(observed[0]?.kind, "matched");
  if (observed[0]?.kind === "matched") assert.equal(observed[0].lastRecreatedAt, null);

  time = 300;
  current = container({
    containerId: "replacement",
    image: "ghcr.io/unimatrixcore/unimatrix-api@sha256:abc",
  });
  observed = await observer.poll();
  assert.equal(observed[0]?.kind, "matched");
  if (observed[0]?.kind === "matched") {
    assert.equal(observed[0].lastRecreatedAt, 300);
    assert.equal(observed[0].firstObservedAt, 300);
  }
});

void test("ambiguous, lookalike, and failed reads are unknown rather than down or stale", async () => {
  let entries = [container()];
  let fail = false;
  let time = 100;
  let readFailures = 0;
  const observer = createContainerObserver(
    {
      getContainers: () =>
        fail ? Promise.reject(new Error("sensitive response body")) : Promise.resolve(entries),
    },
    desired.slice(0, 1),
    () => time,
    () => {
      readFailures += 1;
    },
  );
  await observer.poll();

  time = 200;
  entries = [container(), container({ containerId: "second" })];
  assert.deepEqual((await observer.poll())[0], {
    appDir: "api",
    kind: "unknown",
    reason: "ambiguous",
    observedAt: 200,
  });

  time = 300;
  entries = [container({ image: "ghcr.io/unimatrixcore/unimatrix-api-extra:main" })];
  assert.deepEqual((await observer.poll())[0], {
    appDir: "api",
    kind: "unknown",
    reason: "no-match",
    observedAt: 300,
  });

  time = 400;
  fail = true;
  assert.deepEqual((await observer.poll())[0], {
    appDir: "api",
    kind: "unknown",
    reason: "poll-failed",
    observedAt: 400,
  });
  assert.equal(readFailures, 1);
});

void test("unknown samples do not erase the last matched identity or recreation time", async () => {
  let time = 100;
  let entries = [container()];
  let fail = false;
  const observer = createContainerObserver(
    {
      getContainers: () =>
        fail ? Promise.reject(new Error("read failed")) : Promise.resolve(entries),
    },
    desired.slice(0, 1),
    () => time,
  );

  await observer.poll();
  time = 200;
  entries = [container({ containerId: "second" })];
  await observer.poll();

  time = 300;
  fail = true;
  assert.equal((await observer.poll())[0]?.kind, "unknown");
  time = 400;
  fail = false;
  let observed = (await observer.poll())[0];
  assert.equal(observed?.kind, "matched");
  if (observed?.kind === "matched") {
    assert.equal(observed.firstObservedAt, 200);
    assert.equal(observed.lastRecreatedAt, 200);
  }

  time = 500;
  entries = [];
  assert.equal((await observer.poll())[0]?.kind, "unknown");
  time = 600;
  entries = [container({ containerId: "third" })];
  observed = (await observer.poll())[0];
  assert.equal(observed?.kind, "matched");
  if (observed?.kind === "matched") {
    assert.equal(observed.firstObservedAt, 600);
    assert.equal(observed.lastRecreatedAt, 600);
  }

  time = 700;
  entries = [container({ containerId: "third" }), container({ containerId: "fourth" })];
  assert.equal((await observer.poll())[0]?.kind, "unknown");
  time = 800;
  entries = [container({ containerId: "third" })];
  observed = (await observer.poll())[0];
  assert.equal(observed?.kind, "matched");
  if (observed?.kind === "matched") {
    assert.equal(observed.firstObservedAt, 600);
    assert.equal(observed.lastRecreatedAt, 600);
  }
});

void test("concurrent callers share a single in-flight Docker read", async () => {
  let reads = 0;
  let release: ((value: DokployContainer[]) => void) | undefined;
  const observer = createContainerObserver(
    {
      getContainers: () => {
        reads += 1;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    desired.slice(0, 1),
  );

  const first = observer.poll();
  const second = observer.poll();
  assert.equal(first, second);
  assert.equal(reads, 1);
  release?.([container()]);
  await first;
});

void test("runtime metadata attaches only to the same app and exact container identity", async () => {
  const metadata = {
    name: "actual-container",
    startedAt: 10,
    health: "healthy" as const,
    imageTag: "sha-new",
    commit: "a".repeat(40),
    commitSubject: "New commit",
  };
  const evidence = {
    app: "api",
    containerId: "a".repeat(64),
    observedAt: 100,
    metadata,
    image: {
      repository: desired[0]!.image,
      platform: "linux/amd64",
      digestKind: "manifest" as const,
      digest: `sha256:${"b".repeat(64)}`,
    },
  };
  const observer = createContainerObserver(
    { getContainers: () => Promise.resolve([container({ containerId: evidence.containerId })]) },
    desired.slice(0, 1),
    () => 100,
    undefined,
    () => Promise.resolve([evidence]),
  );
  const observed = (await observer.poll())[0];
  assert.equal(observed?.kind, "matched");
  if (observed?.kind === "matched") {
    assert.equal(observed.startedAt, 10);
    assert.equal(observed.health, "healthy");
    assert.equal(observed.name, "actual-container");
    assert.equal(observed.runtimeMetadataObservedAt, 100);
  }
  const other = createContainerObserver(
    { getContainers: () => Promise.resolve([container({ containerId: "different" })]) },
    desired.slice(0, 1),
    () => 100,
    undefined,
    () => Promise.resolve([evidence]),
  );
  const unmatched = (await other.poll())[0];
  if (unmatched?.kind === "matched") assert.equal(unmatched.startedAt, null);
});

void test("runtime metadata resolves only unique full identities from valid abbreviated IDs", async (t) => {
  const fullId = "a".repeat(64);
  const evidence: DeployAttemptRuntimeEvidence = {
    app: "api",
    containerId: fullId,
    observedAt: 100,
    metadata: {
      name: "actual-container",
      startedAt: 10,
      health: "healthy",
      imageTag: null,
      commit: null,
      commitSubject: null,
    },
    image: {
      repository: desired[0]!.image,
      platform: "linux/amd64",
      digestKind: "manifest",
      digest: `sha256:${"b".repeat(64)}`,
    },
  };
  const cases = [
    { name: "12-character prefix", id: fullId.slice(0, 12), entries: [evidence], matches: true },
    { name: "longer prefix", id: fullId.slice(0, 63), entries: [evidence], matches: true },
    { name: "too short", id: fullId.slice(0, 11), entries: [evidence], matches: false },
    { name: "unrelated ID", id: "b".repeat(12), entries: [evidence], matches: false },
    { name: "non-hex prefix", id: "container-id", entries: [evidence], matches: false },
    { name: "overlong ID", id: "a".repeat(65), entries: [evidence], matches: false },
    {
      name: "evidence must contain a full ID",
      id: fullId.slice(0, 12),
      entries: [{ ...evidence, containerId: fullId.slice(0, 63) }],
      matches: false,
    },
    {
      name: "different app",
      id: fullId.slice(0, 12),
      entries: [{ ...evidence, app: "web" }],
      matches: false,
    },
    {
      name: "different repository even with exact ID",
      id: fullId,
      entries: [{ ...evidence, image: { ...evidence.image, repository: desired[1]!.image } }],
      matches: false,
    },
    {
      name: "duplicate exact evidence",
      id: fullId,
      entries: [evidence, evidence],
      matches: false,
    },
    {
      name: "duplicate abbreviated evidence",
      id: fullId.slice(0, 12),
      entries: [evidence, evidence],
      matches: false,
    },
    {
      name: "colliding full IDs",
      id: fullId.slice(0, 12),
      entries: [evidence, { ...evidence, containerId: "a".repeat(63) + "b" }],
      matches: false,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const observer = createContainerObserver(
        { getContainers: () => Promise.resolve([container({ containerId: scenario.id })]) },
        desired.slice(0, 1),
        () => 100,
        undefined,
        () => Promise.resolve(scenario.entries),
      );
      const observed = (await observer.poll())[0];
      assert.equal(observed?.kind, "matched");
      if (observed?.kind !== "matched") assert.fail("Expected a container observation");
      assert.equal(observed.containerId, scenario.id);
      assert.equal(observed.startedAt, scenario.matches ? 10 : null);
      assert.equal(observed.health, scenario.matches ? "healthy" : null);
      assert.equal(observed.runtimeMetadataObservedAt, scenario.matches ? 100 : null);
      assert.equal(observed.firstObservedAt, 100);
      assert.equal(observed.lastRecreatedAt, null);
    });
  }
  await t.test("temporary missing evidence does not imply container recreation", async () => {
    let time = 100;
    let entries = [evidence];
    const observer = createContainerObserver(
      { getContainers: () => Promise.resolve([container({ containerId: fullId.slice(0, 12) })]) },
      desired.slice(0, 1),
      () => time,
      undefined,
      () => Promise.resolve(entries),
    );
    await observer.poll();
    entries = [];
    time = 200;
    const missing = (await observer.poll())[0];
    assert.equal(missing?.kind, "matched");
    if (missing?.kind !== "matched") assert.fail("Expected a container observation");
    assert.equal(missing.startedAt, null);
    assert.equal(missing.firstObservedAt, 100);
    assert.equal(missing.lastRecreatedAt, null);
    entries = [evidence];
    time = 300;
    const restored = (await observer.poll())[0];
    assert.equal(restored?.kind, "matched");
    if (restored?.kind !== "matched") assert.fail("Expected a container observation");
    assert.equal(restored.startedAt, 10);
    assert.equal(restored.firstObservedAt, 100);
    assert.equal(restored.lastRecreatedAt, null);
  });
});
