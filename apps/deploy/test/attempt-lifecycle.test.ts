import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import type { DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

import { setupDeploymentAttempts } from "../src/attempts/lifecycle.js";
import { ATTEMPT_DEADLINE_MS } from "../src/attempts/model.js";
import { openDeploymentAttemptStore, type DeploymentAttemptStore } from "../src/attempts/store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function storeFixture(observe: DeploymentAttemptStore["observe"]) {
  let closed = false;
  const store: DeploymentAttemptStore = {
    findRollback: () => assert.fail("unused"),
    reserveRollback: () => assert.fail("unused"),
    claimExecution: () => assert.fail("unused"),
    resolveAlreadyCurrent: () => assert.fail("unused"),
    reserveManual: () => assert.fail("unused"),
    findManual: () => assert.fail("unused"),
    intent: () => assert.fail("unused"),
    report: () => assert.fail("unused"),
    recoverInterruptedQueues: () => undefined,
    list: () => assert.fail("unused"),
    get: () => assert.fail("unused"),
    observe,
    close() {
      closed = true;
    },
  };
  return { store, isClosed: () => closed };
}

void test("attempt lifecycle closes an unstarted owned store", async () => {
  const app = Fastify();
  setupDeploymentAttempts(app, ":memory:");
  await app.ready();
  assert.deepEqual(app.deploymentAttempts.list(undefined, 1, Date.now()), []);
  await app.close();
  assert.throws(() => app.deploymentAttempts.list(undefined, 1, Date.now()), /not open/u);
});

void test("failed interrupted-queue recovery prevents service readiness and runtime sampling", async () => {
  const app = Fastify();
  let observations = 0;
  let reads = 0;
  const fixture = storeFixture(() => {
    observations += 1;
  });
  fixture.store.recoverInterruptedQueues = () => {
    throw new Error("recovery failed");
  };
  setupDeploymentAttempts(app, ":memory:", fixture.store, () => {
    reads += 1;
    return Promise.resolve([]);
  });
  try {
    await assert.rejects(async () => {
      await app.ready();
    }, /recovery failed/u);
    assert.equal(reads, 0);
    assert.equal(observations, 0);
  } finally {
    await app.close();
    assert.equal(fixture.isClosed(), true);
  }
});

void test("shutdown drains a pending runtime read before closing the durable store", async () => {
  const app = Fastify();
  const read = deferred<DeployAttemptRuntimeEvidence[]>();
  const entered = deferred<void>();
  let observations = 0;
  const fixture = storeFixture((evidence) => {
    assert.equal(fixture.isClosed(), false);
    assert.deepEqual(evidence, []);
    observations += 1;
  });
  setupDeploymentAttempts(app, ":memory:", fixture.store, () => {
    entered.resolve();
    return read.promise;
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await entered.promise;
  const closing = app.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.isClosed(), false);
  read.resolve([]);
  await closing;
  assert.equal(observations, 1);
  assert.equal(fixture.isClosed(), true);
});

void test("bridge failure still expires missing callbacks and logs no source error", async () => {
  const app = Fastify();
  const store = openDeploymentAttemptStore(":memory:");
  const record = store.intent(
    {
      repository: "unimatrixcore/unimatrix-01",
      runId: "1",
      runAttempt: 1,
      app: "api",
      trigger: "ci",
      image: {
        repository: "ghcr.io/unimatrixcore/unimatrix-api",
        tag: "main",
        commit: "a".repeat(40),
        platform: "linux/amd64",
        digestKind: "manifest",
        digest: `sha256:${"b".repeat(64)}`,
      },
    },
    "reporter",
    null,
    Date.now() - ATTEMPT_DEADLINE_MS - 1000,
  );
  const warnings: unknown[][] = [];
  const originalObserve = store.observe.bind(store);
  const observed = deferred<void>();
  store.observe = (evidence, now) => {
    originalObserve(evidence, now);
    observed.resolve();
  };
  app.log.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  setupDeploymentAttempts(app, ":memory:", store, () =>
    Promise.reject(new Error("private bridge failure")),
  );
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    await observed.promise;
    assert.equal(store.list(undefined, 1, Date.now())[0]!.id, record.id);
    assert.equal(store.list(undefined, 1, Date.now())[0]!.outcome, "timed-out");
    assert.deepEqual(warnings, [["deployment attempt observation unavailable"]]);
  } finally {
    await app.close();
  }
});

void test("database observation failure is contained and polling stops after shutdown", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const app = Fastify();
  let reads = 0;
  let writes = 0;
  const warnings: unknown[][] = [];
  const fixture = storeFixture(() => {
    writes += 1;
    throw new Error("private database failure");
  });
  app.log.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  setupDeploymentAttempts(app, ":memory:", fixture.store, () => {
    reads += 1;
    return Promise.resolve([]);
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(writes, 2);
    context.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(writes, 4);
    assert.equal(JSON.stringify(warnings).includes("private"), false);
    await app.close();
    context.mock.timers.tick(60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(fixture.isClosed(), true);
  } finally {
    await app.close();
    context.mock.timers.reset();
  }
});
