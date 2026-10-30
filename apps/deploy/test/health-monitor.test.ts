import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import Fastify from "fastify";

import { setupHealthMonitoring } from "../src/health-history/lifecycle.js";
import { createHealthMonitor, startHealthPolling } from "../src/health-history/monitor.js";
import type { HealthObservation } from "../src/health-history/model.js";
import { openHealthHistoryStore } from "../src/health-history/store.js";

const NOW = 1_800_000_000_000;
const TARGET = { app: "api", url: "http://api:3001/health", configured: true };

void test("monitor coalesces polls, records results, and stops without recording cancellation", async () => {
  const store = openHealthHistoryStore(":memory:", ["api"], NOW);
  let finish: ((state: HealthObservation["state"]) => void) | undefined;
  let calls = 0;
  const monitor = createHealthMonitor(
    [TARGET],
    store,
    () => NOW,
    async (_target, signal) => {
      calls += 1;
      return new Promise((resolve) => {
        finish = resolve;
        signal.addEventListener(
          "abort",
          () => {
            resolve("unknown");
          },
          { once: true },
        );
      });
    },
  );
  try {
    const first = monitor.poll();
    assert.equal(monitor.poll(), first);
    assert.equal(calls, 1);
    finish?.("up");
    await first;
    assert.equal(store.snapshot("api", NOW).current.state, "up");
    const second = monitor.poll();
    await monitor.stop();
    await second;
    await monitor.poll();
    assert.equal(calls, 2);
    assert.equal(store.snapshot("api", NOW).current.state, "up");
  } finally {
    await monitor.stop();
    store.close();
  }
});

void test("one failed write does not let stop close the database before other probes settle", async () => {
  const store = openHealthHistoryStore(":memory:", ["api"], NOW);
  let finish: ((state: HealthObservation["state"]) => void) | undefined;
  const monitor = createHealthMonitor(
    [TARGET, { ...TARGET, app: "other" }],
    store,
    () => NOW,
    async (target) =>
      target.app === "api"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : "up",
  );
  const poll = monitor.poll();
  const rejected = assert.rejects(poll, /Health observation failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  let stopped = false;
  const stop = monitor.stop().finally(() => {
    stopped = true;
  });
  const stopRejected = assert.rejects(stop, /Health observation failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finish?.("up");
  await rejected;
  await stopRejected;
  store.close();
});

void test("poll scheduler starts immediately and retries after errors without overlapping", async () => {
  let calls = 0;
  let errors = 0;
  let stopCalled = false;
  let second: (() => void) | undefined;
  const secondCalled = new Promise<void>((resolve) => {
    second = resolve;
  });
  const stop = startHealthPolling(
    {
      poll() {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("private error"));
        second?.();
        return Promise.resolve();
      },
      stop() {
        stopCalled = true;
        return Promise.resolve();
      },
    },
    () => {
      errors += 1;
    },
    1,
  );
  assert.equal(calls, 1);
  await secondCalled;
  await stop();
  const count = calls;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, count);
  assert.equal(errors, 1);
  assert.equal(stopCalled, true);
});

void test("shutdown during an active scheduled sample prevents another timer", async () => {
  let resolvePoll: (() => void) | undefined;
  let calls = 0;
  const active = new Promise<void>((resolve) => {
    resolvePoll = resolve;
  });
  const stop = startHealthPolling(
    {
      poll() {
        calls += 1;
        return active;
      },
      async stop() {
        resolvePoll?.();
        await active;
      },
    },
    () => assert.fail(),
    1,
  );
  await stop();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
});

void test("Fastify lifecycle starts collection on listen and closes persistence after shutdown", async () => {
  const endpoint = createServer((_request, response) => {
    response.end("ok");
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const address = endpoint.address();
  assert.ok(address && typeof address !== "string");
  const app = Fastify();
  setupHealthMonitoring(app, ":memory:", [
    { ...TARGET, url: `http://127.0.0.1:${String(address.port)}` },
  ]);
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    for (
      let attempt = 0;
      attempt < 100 && app.healthHistory.snapshot("api", Date.now()).current.state !== "up";
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(app.healthHistory.snapshot("api", Date.now()).current.state, "up");
    await app.close();
    assert.throws(() => app.healthHistory.snapshot("api", Date.now()), /not open/);
  } finally {
    await app.close();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) =>
      endpoint.close(() => {
        resolve();
      }),
    );
  }
});

void test("closing before listen releases the health database", async () => {
  const app = Fastify();
  setupHealthMonitoring(app, ":memory:", [TARGET]);
  await app.ready();
  await app.close();
  assert.throws(() => app.healthHistory.snapshot("api", Date.now()), /not open/);
});
