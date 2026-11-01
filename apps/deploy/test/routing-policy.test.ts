import assert from "node:assert/strict";
import test from "node:test";
import { compareRouting, ROUTING_POLICY_PATH } from "../src/reconcile/routing-policy.js";

const service = { appDir: "api", containerPort: 3001 };
const route = { host: "api.unimatrix-01.dev", https: true, port: 3001, path: "/" };

void test("routing compares declared host sets and target ports without treating unavailable reads as absence", () => {
  for (const absent of [undefined, null]) {
    const result = compareRouting(service, absent);
    assert.equal(result.status, "unavailable");
    assert.equal(result.observedHosts, null);
    assert.equal(result.observedPorts, null);
    assert.deepEqual(result.missingHosts, []);
    assert.equal(result.portMismatch, false);
  }
  const matching = compareRouting(service, [route, { ...route, host: "API.UNIMATRIX-01.DEV" }]);
  assert.equal(matching.status, "in-sync");
  assert.equal(matching.sourcePath, ROUTING_POLICY_PATH);
  assert.deepEqual(matching.expectedHosts, [route.host]);
  assert.deepEqual(matching.observedHosts, [route.host]);
  assert.deepEqual(matching.observedPorts, [3001, 3001]);
  const missing = compareRouting(service, []);
  assert.equal(missing.status, "drift");
  assert.deepEqual(missing.missingHosts, [route.host]);
  assert.deepEqual(missing.observedPorts, []);
  const differing = compareRouting(service, [{ ...route, host: "other.example.test", port: 8080 }]);
  assert.equal(differing.status, "drift");
  assert.deepEqual(differing.missingHosts, [route.host]);
  assert.deepEqual(differing.unexpectedHosts, ["other.example.test"]);
  assert.equal(differing.portMismatch, true);
  assert.equal(compareRouting(service, [{ ...route, port: null }]).status, "unavailable");
  assert.equal(
    compareRouting(service, [
      { ...route, port: null },
      { ...route, port: 8080 },
    ]).status,
    "drift",
  );
});

void test("unrouted declarations and compatibility hostnames remain explicit policy", () => {
  for (const appDir of ["deploy", "secrets"]) {
    assert.equal(compareRouting({ appDir, containerPort: 3001 }, []).status, "in-sync");
    const result = compareRouting({ appDir, containerPort: 3001 }, [route]);
    assert.equal(result.status, "drift");
    assert.deepEqual(result.unexpectedHosts, [route.host]);
  }
  const cflop = compareRouting({ appDir: "cflop", containerPort: 8080 }, [
    { ...route, host: "cube.unimatrix-01.dev", port: 8080 },
    { ...route, host: "cflop.unimatrix-01.dev", port: 8080 },
  ]);
  assert.equal(cflop.status, "in-sync");
  const unknown = compareRouting({ appDir: "new-app", containerPort: 1234 }, [route]);
  assert.equal(unknown.status, "not-declared");
  assert.deepEqual(unknown.expectedHosts, []);
  assert.deepEqual(unknown.missingHosts, []);
  assert.deepEqual(unknown.unexpectedHosts, []);
  assert.equal(unknown.portMismatch, false);
});
