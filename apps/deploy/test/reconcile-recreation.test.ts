import assert from "node:assert/strict";
import test from "node:test";

import { runReconcileCli, type ReconcileCliDeps } from "../src/cli/reconcile.js";
import type { EnableRecreationResult } from "../src/dokploy/recreation-client.js";
import { enableAppRecreation } from "../src/reconcile/recreation.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";

function fixture(appDir = "api", result: EnableRecreationResult = "applied") {
  const calls: string[] = [];
  const lines: string[] = [];
  const row = {
    composeId: "c",
    name: appDir,
    owner: "unimatrixcore",
    repository: "unimatrix-01",
    sourceType: "github",
    appName: "app-project",
    composePath: `./infra/docker/${appDir}-compose.yaml`,
    composeType: "docker-compose",
    createEnvFile: true,
    serverId: null,
    mountCount: 0,
    policy: "disabled" as const,
  };
  const deps: ReconcileCliDeps = {
    client: {
      getProjects: () => {
        calls.push("projects");
        return Promise.resolve([
          {
            projectId: "p",
            name: "p",
            environments: [
              {
                environmentId: "e",
                name: "e",
                compose: [{ composeId: "c", name: appDir, composeStatus: "done" }],
              },
            ],
          },
        ]);
      },
      getCompose: () => assert.fail("general compose read not used"),
      getContainers: () => assert.fail("not used"),
      getDokployVersion: () => assert.fail("not used"),
      updateComposeSettings: () => assert.fail("general settings not used"),
    },
    recreation: {
      inspect: () => {
        calls.push("inspect");
        return Promise.resolve(row);
      },
      enable: (expected) => {
        calls.push("enable");
        assert.equal(expected, row);
        return Promise.resolve(result);
      },
    },
    desired: DEPLOY_DESIRED_STATE,
    secretEnv: null,
    write: (line) => lines.push(line),
  };
  return { deps, row, calls, lines };
}

void test("host recreation configuration permits self and returns closed CLI states", async () => {
  for (const [result, exit] of [
    ["applied", 0],
    ["already-enabled", 1],
    ["refused", 2],
    ["write-status-unknown", 3],
    ["verification-failed", 5],
  ] as const) {
    const f = fixture("deploy", result);
    assert.equal(await runReconcileCli(["enable-recreation", "deploy"], f.deps), exit);
    assert.deepEqual(f.calls, ["projects", "inspect", "enable"]);
    assert.deepEqual(f.lines, [`deploy: ${result.toUpperCase()}`]);
  }
});

void test("undeclared, missing, foreign and drifted settings never write", async () => {
  const unknown = fixture();
  assert.equal(
    (
      await enableAppRecreation(
        unknown.deps.client,
        unknown.deps.recreation!,
        DEPLOY_DESIRED_STATE,
        "absent",
      )
    ).outcome,
    "unknown-app",
  );
  assert.deepEqual(unknown.calls, []);
  for (const patch of [
    { owner: "foreign" },
    { repository: "other" },
    { sourceType: "raw" },
    { composePath: "infra/docker/web-compose.yaml" },
    { composeId: "other" },
    { name: "other" },
  ]) {
    const f = fixture();
    Object.assign(f.row, patch);
    assert.equal(
      (await enableAppRecreation(f.deps.client, f.deps.recreation!, DEPLOY_DESIRED_STATE, "api"))
        .outcome,
      "refused",
    );
    assert.equal(f.calls.includes("enable"), false);
  }
  const missing = fixture();
  missing.deps.client.getProjects = () => Promise.resolve([]);
  assert.equal(
    (
      await enableAppRecreation(
        missing.deps.client,
        missing.deps.recreation!,
        DEPLOY_DESIRED_STATE,
        "api",
      )
    ).outcome,
    "not-matched",
  );
});

void test("CLI missing capability and read failures have bounded outputs", async () => {
  const f = fixture();
  const without = { ...f.deps };
  delete without.recreation;
  assert.equal(await runReconcileCli(["enable-recreation", "api"], without), 2);
  f.deps.client.getProjects = () => Promise.reject(new Error("private-detail"));
  assert.equal(await runReconcileCli(["enable-recreation", "api"], f.deps), 4);
  assert.doesNotMatch(f.lines.join("\n"), /private-detail/);
  assert.equal(await runReconcileCli(["enable-recreation"], f.deps), 2);
});
