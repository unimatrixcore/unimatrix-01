import assert from "node:assert/strict";
import test from "node:test";

import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployCreationCompose } from "../src/dokploy/creation-client.js";
import type { DokployProject } from "../src/dokploy/schemas.js";
import { createMissingService } from "../src/reconcile/create.js";

const DESIRED: DeployDesiredState = [
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
    healthProbe: { url: "http://api:3001/health" },
  },
];
const TARGET = { environmentId: "env-1", githubId: "github-1" };
const DISCONNECTED: DokployCreationCompose = {
  composeId: "compose-1",
  name: "api",
  description: null,
  environmentId: "env-1",
  composeType: "docker-compose",
  sourceType: "raw",
  owner: null,
  repository: null,
  branch: null,
  autoDeploy: true,
  composePath: "./docker-compose.yml",
  githubId: null,
};
const CONFIGURED: DokployCreationCompose = {
  ...DISCONNECTED,
  sourceType: "github",
  owner: "unimatrixcore",
  repository: "unimatrix-01",
  branch: "main",
  autoDeploy: false,
  composePath: "infra/docker/api-compose.yaml",
  githubId: "github-1",
};

function projects(names: readonly string[] = []): DokployProject[] {
  return [
    {
      projectId: "project-1",
      name: "project",
      environments: [
        {
          environmentId: "env-1",
          name: "production",
          compose: names.map((name, index) => ({
            name,
            composeId: `compose-${index + 1}`,
            composeStatus: "idle",
          })),
        },
      ],
    },
  ];
}

function harness() {
  const calls: string[] = [];
  let created = false;
  let configured = false;
  const reserved = new Set<string>();
  const state: { description: string | null } = { description: null };
  const readback = (row: DokployCreationCompose): DokployCreationCompose => ({
    ...row,
    description: state.description,
  });
  const client = {
    getProjects: () => {
      calls.push("projects");
      return Promise.resolve(projects(created ? ["api"] : []));
    },
  };
  const creation = {
    createCompose: (input: { name: string; environmentId: string; description: string }) => {
      calls.push("create");
      assert.equal(input.name, "api");
      assert.equal(input.environmentId, "env-1");
      assert.match(input.description, /^unimatrix-create:[0-9a-f-]{36}$/u);
      state.description = input.description;
      created = true;
      return Promise.resolve();
    },
    configureCompose: (composeId: string, source: { composePath: string; githubId: string }) => {
      calls.push("configure");
      assert.equal(composeId, "compose-1");
      assert.deepEqual(source, {
        composePath: "infra/docker/api-compose.yaml",
        githubId: "github-1",
      });
      configured = true;
      return Promise.resolve();
    },
    getCompose: (composeId: string) => {
      calls.push("compose");
      assert.equal(composeId, "compose-1");
      return Promise.resolve(readback(configured ? CONFIGURED : DISCONNECTED));
    },
  };
  const store = {
    reserve: (appDir: string) => {
      calls.push("reserve");
      if (reserved.has(appDir)) return false;
      reserved.add(appDir);
      return true;
    },
  };
  return {
    calls,
    state,
    readback,
    client,
    creation,
    store,
    run: (appDir = "api") => createMissingService(client, creation, store, DESIRED, appDir, TARGET),
  };
}

void test("self and undeclared apps are refused before every network and reservation call", async () => {
  const h = harness();
  assert.deepEqual(await h.run("deploy"), { appDir: "deploy", outcome: "refused-self" });
  assert.deepEqual(await h.run("unknown"), { appDir: "unknown", outcome: "unknown-app" });
  assert.deepEqual(h.calls, []);
});

void test("an existing name anywhere in Dokploy prevents creation", async () => {
  const h = harness();
  h.client.getProjects = () =>
    Promise.resolve([
      {
        projectId: "foreign-project",
        name: "foreign",
        environments: [
          {
            environmentId: "foreign-env",
            name: "foreign",
            compose: [{ name: "api", composeId: "foreign-compose", composeStatus: "idle" }],
          },
        ],
      },
      ...projects(),
    ]);
  assert.deepEqual(await h.run(), { appDir: "api", outcome: "not-missing" });
  assert.deepEqual(h.calls, []);
});

void test("missing and duplicated environment targets are refused before reservation", async () => {
  for (const targetProjects of [[], [...projects(), ...projects()]]) {
    const h = harness();
    h.client.getProjects = () => Promise.resolve(targetProjects);
    assert.deepEqual(await h.run(), { appDir: "api", outcome: "invalid-target" });
    assert.deepEqual(h.calls, []);
  }
});

void test("project and reservation errors cannot invoke creation", async () => {
  const unreadable = harness();
  unreadable.client.getProjects = () => Promise.reject(new Error("private error"));
  assert.deepEqual(await unreadable.run(), { appDir: "api", outcome: "error" });
  assert.deepEqual(unreadable.calls, []);

  const unreservable = harness();
  unreservable.store.reserve = () => {
    throw new Error("private database error");
  };
  assert.deepEqual(await unreservable.run(), { appDir: "api", outcome: "error" });
  assert.deepEqual(unreservable.calls, ["projects"]);

  const reserved = harness();
  reserved.store.reserve = () => false;
  assert.deepEqual(await reserved.run(), { appDir: "api", outcome: "already-attempted" });
  assert.deepEqual(reserved.calls, ["projects"]);
});

void test("creation configures only its freshly observed disconnected row, then verifies every setting", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { appDir: "api", outcome: "created" });
  assert.deepEqual(h.calls, [
    "projects",
    "reserve",
    "create",
    "projects",
    "compose",
    "configure",
    "projects",
    "compose",
  ]);
});

void test("mismatched identity or existing repository configuration prevents source configuration", async () => {
  for (const [patch, state] of [
    [{ composeId: "foreign-id" }, "ambiguous"],
    [{ name: "foreign-name" }, "ambiguous"],
    [{ environmentId: "foreign-env" }, "ambiguous"],
    [{ sourceType: "github" }, "unconfigured"],
    [{ owner: "foreign-owner" }, "unconfigured"],
    [{ repository: "foreign-repository" }, "unconfigured"],
    [{ githubId: "foreign-provider" }, "unconfigured"],
    [{ branch: "foreign-branch" }, "unconfigured"],
    [{ composeType: "stack" }, "unconfigured"],
  ] as const) {
    const h = harness();
    h.creation.getCompose = () => Promise.resolve(h.readback({ ...DISCONNECTED, ...patch }));
    assert.deepEqual(await h.run(), {
      appDir: "api",
      outcome: "verification-failed",
      observed: state,
    });
    assert.equal(h.calls.includes("configure"), false);
  }
});

void test("a silent configuration drop fails verification for each pinned setting", async () => {
  for (const patch of [
    { sourceType: "raw" },
    { composeType: "stack" },
    { owner: "foreign-owner" },
    { repository: "foreign-repository" },
    { branch: "foreign-branch" },
    { autoDeploy: true },
    { githubId: "foreign-provider" },
    { composePath: "other.yaml" },
  ]) {
    const h = harness();
    let reads = 0;
    h.creation.getCompose = () =>
      Promise.resolve(h.readback(reads++ === 0 ? DISCONNECTED : { ...CONFIGURED, ...patch }));
    assert.deepEqual(await h.run(), {
      appDir: "api",
      outcome: "verification-failed",
      observed: "unconfigured",
    });
    assert.equal(h.calls.filter((call) => call === "configure").length, 1);
  }
});

void test("a configure timeout preserves unknown status even when fresh readback matches", async () => {
  const h = harness();
  let reads = 0;
  h.creation.getCompose = () =>
    Promise.resolve(h.readback(reads++ === 0 ? DISCONNECTED : CONFIGURED));
  h.creation.configureCompose = () => {
    h.calls.push("configure");
    return Promise.reject(new Error("timeout"));
  };
  assert.deepEqual(await h.run(), {
    appDir: "api",
    outcome: "write-status-unknown",
    observed: "configured",
  });
  assert.equal(h.calls.filter((call) => call === "configure").length, 1);
});

void test("create timeout only observes fresh state and never configures or repeats creation", async () => {
  for (const state of ["missing", "disconnected", "ambiguous", "unavailable"] as const) {
    const h = harness();
    let reads = 0;
    h.client.getProjects = () => {
      if (reads++ === 0) return Promise.resolve(projects());
      if (state === "unavailable") return Promise.reject(new Error("private read failure"));
      return Promise.resolve(
        projects(state === "missing" ? [] : state === "ambiguous" ? ["api", "api"] : ["api"]),
      );
    };
    h.creation.createCompose = (input) => {
      h.state.description = input.description;
      h.calls.push("create");
      return Promise.reject(new Error("private timeout"));
    };
    assert.deepEqual(await h.run(), {
      appDir: "api",
      outcome: "write-status-unknown",
      observed: state,
    });
    assert.equal(h.calls.filter((call) => call === "create").length, 1);
    assert.equal(h.calls.includes("configure"), false);
  }
});

void test("an uncertain create reservation prevents another POST even when discovery stays missing", async () => {
  const h = harness();
  h.creation.createCompose = () => {
    h.calls.push("create");
    return Promise.reject(new Error("timeout"));
  };
  assert.deepEqual(await h.run(), {
    appDir: "api",
    outcome: "write-status-unknown",
    observed: "missing",
  });
  assert.deepEqual(await h.run(), { appDir: "api", outcome: "already-attempted" });
  assert.equal(h.calls.filter((call) => call === "create").length, 1);
});

void test("failed discovery or detail readback after acknowledged creation cannot report success", async () => {
  for (const state of ["missing", "ambiguous", "unavailable"] as const) {
    const h = harness();
    let reads = 0;
    h.client.getProjects = () => {
      if (reads++ === 0) return Promise.resolve(projects());
      return Promise.resolve(
        projects(state === "missing" ? [] : state === "ambiguous" ? ["api", "api"] : ["api"]),
      );
    };
    h.creation.getCompose = () => Promise.reject(new Error("private read failure"));
    assert.deepEqual(await h.run(), {
      appDir: "api",
      outcome: "verification-failed",
      observed: state,
    });
    assert.equal(h.calls.includes("configure"), false);
  }
});

void test("verified configuration accepts the same normalized compose path as reconciliation", async () => {
  const h = harness();
  let reads = 0;
  h.creation.getCompose = () =>
    Promise.resolve(
      h.readback(
        reads++ === 0
          ? DISCONNECTED
          : { ...CONFIGURED, composePath: `./${CONFIGURED.composePath}` },
      ),
    );
  assert.deepEqual(await h.run(), { appDir: "api", outcome: "created" });
});

void test("a replacement compose ID after configuration cannot confirm the original creation", async () => {
  const h = harness();
  let reads = 0;
  h.client.getProjects = () => {
    const read = reads++;
    if (read === 0) return Promise.resolve(projects());
    const found = projects(["api"]);
    if (read > 1) {
      const environment = found[0]?.environments[0];
      assert.ok(environment);
      environment.compose[0] = { name: "api", composeId: "replacement", composeStatus: "idle" };
    }
    return Promise.resolve(found);
  };
  h.creation.getCompose = (composeId) =>
    Promise.resolve(
      h.readback(composeId === "compose-1" ? DISCONNECTED : { ...CONFIGURED, composeId }),
    );

  assert.deepEqual(await h.run(), {
    appDir: "api",
    outcome: "verification-failed",
    observed: "configured",
  });
});

void test("a disconnected row without this invocation's marker cannot receive source configuration", async () => {
  for (const description of [null, "unimatrix-create:another-invocation"]) {
    const h = harness();
    h.creation.getCompose = () => Promise.resolve({ ...DISCONNECTED, description });

    assert.deepEqual(await h.run(), {
      appDir: "api",
      outcome: "verification-failed",
      observed: "ambiguous",
    });
    assert.equal(h.calls.includes("configure"), false);
  }
});

void test("changing the provenance marker during configuration prevents success", async () => {
  const h = harness();
  let reads = 0;
  h.creation.getCompose = () =>
    Promise.resolve(
      reads++ === 0
        ? h.readback(DISCONNECTED)
        : { ...CONFIGURED, description: "unimatrix-create:another-invocation" },
    );

  assert.deepEqual(await h.run(), {
    appDir: "api",
    outcome: "verification-failed",
    observed: "ambiguous",
  });
});
