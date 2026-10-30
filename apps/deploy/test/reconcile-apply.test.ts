import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { DeployDesiredService, DeployDesiredState } from "@unimatrix/deploy-config";

import type { DokployClient, DokployComposeSettingsUpdate } from "../src/dokploy/client.js";
import type { DokployCompose, DokployProject } from "../src/dokploy/schemas.js";
import {
  applyAppSettings,
  RECONCILE_EXPECTED_OWNER,
  RECONCILE_EXPECTED_REPOSITORY,
  RECONCILE_SELF_APP_DIR,
} from "../src/reconcile/apply.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";

function desiredService(overrides: Partial<DeployDesiredService> = {}): DeployDesiredService {
  return {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-api",
    containerPort: 3001,
    env: [{ name: "IMAGE_TAG", required: true }],
    buildArgNames: [],
    publicStatus: true,
    healthProbe: { url: "http://web:8080/" },
    ...overrides,
  };
}

const DESIRED: DeployDesiredState = [desiredService()];

function composeDetail(overrides: Partial<DokployCompose> = {}): DokployCompose {
  return {
    composeId: "compose-1",
    name: "api",
    environmentId: "env-1",
    composePath: "infra/docker/api-compose.yaml",
    sourceType: "github",
    branch: "main",
    autoDeploy: false,
    owner: RECONCILE_EXPECTED_OWNER,
    repository: RECONCILE_EXPECTED_REPOSITORY,
    env: [{ key: "IMAGE_TAG", blank: false }],
    ...overrides,
  };
}

const ONE_MATCH_PROJECTS: DokployProject[] = [
  {
    projectId: "project-1",
    name: "Unimatrix-01",
    environments: [
      {
        environmentId: "env-1",
        name: "production",
        compose: [{ composeId: "compose-1", composeStatus: "done", name: "api" }],
      },
    ],
  },
];

interface CallCounts {
  getProjects: number;
  getCompose: number;
  updateComposeSettings: number;
}

interface StubOptions {
  getProjects?: () => Promise<DokployProject[]>;
  getCompose?: (composeId: string) => Promise<DokployCompose>;
  updateComposeSettings?: (
    composeId: string,
    settings: DokployComposeSettingsUpdate,
  ) => Promise<void>;
}

function stubClient(options: StubOptions = {}): { client: DokployClient; calls: CallCounts } {
  const calls: CallCounts = { getProjects: 0, getCompose: 0, updateComposeSettings: 0 };

  const client: DokployClient = {
    getDokployVersion: () => Promise.reject(new Error("not used")),
    getContainers: () => Promise.reject(new Error("not used")),
    getProjects: () => {
      calls.getProjects += 1;
      return (options.getProjects ?? (() => Promise.resolve(ONE_MATCH_PROJECTS)))();
    },
    getCompose: (composeId) => {
      calls.getCompose += 1;
      return (options.getCompose ?? (() => Promise.resolve(composeDetail())))(composeId);
    },
    updateComposeSettings: (composeId, settings) => {
      calls.updateComposeSettings += 1;
      return (options.updateComposeSettings ?? (() => Promise.resolve()))(composeId, settings);
    },
  };

  return { client, calls };
}

void test("refused-self: getProjects is never called, ordering is the guarantee", async () => {
  const { client, calls } = stubClient();

  const outcome = await applyAppSettings(client, DESIRED, RECONCILE_SELF_APP_DIR);

  assert.deepEqual(outcome, { outcome: "refused-self", appDir: RECONCILE_SELF_APP_DIR });
  assert.equal(calls.getProjects, 0);
  assert.equal(calls.getCompose, 0);
  assert.equal(calls.updateComposeSettings, 0);
});

void test("anchor: the desired-state entry for this service's own package sets appDir to RECONCILE_SELF_APP_DIR", async () => {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(fileURLToPath(packageJsonUrl), "utf8")) as {
    name: string;
  };

  const selfEntry = DEPLOY_DESIRED_STATE.find((entry) => entry.packageName === packageJson.name);

  assert.ok(selfEntry !== undefined, "expected a desired-state entry for this service's package");
  assert.equal(selfEntry.appDir, RECONCILE_SELF_APP_DIR);
});

void test("unknown-app: an appDir absent from the desired-state manifest", async () => {
  const { client, calls } = stubClient();

  const outcome = await applyAppSettings(client, DESIRED, "not-declared-anywhere");

  assert.deepEqual(outcome, { outcome: "unknown-app", appDir: "not-declared-anywhere" });
  assert.equal(calls.getProjects, 0);
});

void test("not-matched: zero Dokploy compose services of that name", async () => {
  const { client } = stubClient({ getProjects: () => Promise.resolve([]) });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, { outcome: "not-matched", appDir: "api", matchCount: 0 });
});

void test("not-matched: more than one Dokploy compose service of that name", async () => {
  const projects: DokployProject[] = [
    {
      projectId: "project-1",
      name: "Unimatrix-01",
      environments: [
        {
          environmentId: "env-1",
          name: "production",
          compose: [
            { composeId: "compose-1", composeStatus: "done", name: "api" },
            { composeId: "compose-2", composeStatus: "done", name: "api" },
          ],
        },
      ],
    },
  ];
  const { client } = stubClient({ getProjects: () => Promise.resolve(projects) });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, { outcome: "not-matched", appDir: "api", matchCount: 2 });
});

void test("refused-foreign-repo: the single match is anchored to a different repository, and nothing is written", async () => {
  const { client, calls } = stubClient({
    getCompose: () => Promise.resolve(composeDetail({ owner: "someone-else", repository: "fork" })),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, {
    outcome: "refused-foreign-repo",
    appDir: "api",
    owner: "someone-else",
    repository: "fork",
  });
  assert.equal(calls.updateComposeSettings, 0);
});

void test("refused-source-type: sourceType drift short-circuits with zero writes", async () => {
  const { client, calls } = stubClient({
    getCompose: () => Promise.resolve(composeDetail({ sourceType: "raw" })),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, { outcome: "refused-source-type", appDir: "api" });
  assert.equal(calls.updateComposeSettings, 0);
});

void test("nothing-to-apply: settings already match; apply never writes env even with env drift present", async () => {
  const { client, calls } = stubClient({
    getCompose: () =>
      Promise.resolve(
        composeDetail({
          env: [
            { key: "IMAGE_TAG", blank: true },
            { key: "HAND_EDITED_AT_2AM", blank: false },
          ],
        }),
      ),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(outcome.outcome, "nothing-to-apply");
  assert.equal(calls.updateComposeSettings, 0);
  if (outcome.outcome !== "nothing-to-apply") throw new Error("unreachable");
  assert.equal(outcome.diff.verdict, "matched");
});

void test("happy path: exactly one updateComposeSettings call and exactly two getCompose calls", async () => {
  let composeCallCount = 0;
  const { client, calls } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      // First read is pre-write drift, second is the post-write re-read confirming it landed.
      return Promise.resolve(
        composeCallCount === 1
          ? composeDetail({ branch: "staging" })
          : composeDetail({ branch: "main" }),
      );
    },
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(calls.updateComposeSettings, 1);
  assert.equal(calls.getCompose, 2);
  assert.equal(outcome.outcome, "applied");
  if (outcome.outcome !== "applied") throw new Error("unreachable");
  assert.deepEqual(outcome.written, ["branch"]);
  assert.equal(outcome.diff.verdict, "matched");
  if (outcome.diff.verdict !== "matched") throw new Error("unreachable");
  assert.equal(outcome.diff.inSync, true);
});

void test("settingsUpdateFor never sends an env key, even for an all-missing env diff (via the wire body)", async () => {
  let capturedSettings: DokployComposeSettingsUpdate | undefined;
  let composeCallCount = 0;
  const { client } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      return Promise.resolve(
        composeCallCount === 1
          ? composeDetail({ branch: "staging", env: [] })
          : composeDetail({ branch: "main", env: [] }),
      );
    },
    updateComposeSettings: (_composeId, settings) => {
      capturedSettings = settings;
      return Promise.resolve();
    },
  });

  const desiredWithRequiredEnv: DeployDesiredState = [
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
  ];

  await applyAppSettings(client, desiredWithRequiredEnv, "api");

  assert.ok(capturedSettings !== undefined);
  assert.equal(Object.hasOwn(capturedSettings, "env"), false);
  assert.deepEqual(Object.keys(capturedSettings).sort(), ["branch"]);
});

void test("needsDeploy is true when composePath or branch was written", async () => {
  let composeCallCount = 0;
  const { client } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      return Promise.resolve(
        composeCallCount === 1
          ? composeDetail({ composePath: "infra/docker/other-compose.yaml" })
          : composeDetail(),
      );
    },
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(outcome.outcome, "applied");
  if (outcome.outcome !== "applied") throw new Error("unreachable");
  assert.equal(outcome.needsDeploy, true);
});

void test("needsDeploy is false when only autoDeploy was written", async () => {
  let composeCallCount = 0;
  const { client } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      return Promise.resolve(
        composeCallCount === 1 ? composeDetail({ autoDeploy: true }) : composeDetail(),
      );
    },
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(outcome.outcome, "applied");
  if (outcome.outcome !== "applied") throw new Error("unreachable");
  assert.deepEqual(outcome.written, ["autoDeploy"]);
  assert.equal(outcome.needsDeploy, false);
});

void test("applied-but-drifted: compose.update resolves, but the re-read still shows the written setting drifted", async () => {
  const { client, calls } = stubClient({
    // Both reads return the same drifted value — the write succeeded on the wire (a 200 that
    // silently changed nothing, or a typo'd field Dokploy's input schema stripped) but never took.
    getCompose: () => Promise.resolve(composeDetail({ branch: "staging" })),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(calls.updateComposeSettings, 1);
  assert.equal(calls.getCompose, 2);
  assert.equal(outcome.outcome, "applied-but-drifted");
  if (outcome.outcome !== "applied-but-drifted") throw new Error("unreachable");
  assert.deepEqual(outcome.written, ["branch"]);
  assert.equal(outcome.diff.verdict, "matched");
  if (outcome.diff.verdict !== "matched") throw new Error("unreachable");
  assert.equal(outcome.diff.inSync, false);
});

void test("a write that throws still produces write-status-unknown carrying the observed post-write state", async () => {
  const { client } = stubClient({
    getCompose: () => Promise.resolve(composeDetail({ branch: "staging" })),
    updateComposeSettings: () => Promise.reject(new Error("timed out")),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(outcome.outcome, "write-status-unknown");
  if (outcome.outcome !== "write-status-unknown") throw new Error("unreachable");
  assert.equal(outcome.writeErrorMessage, "timed out");
  assert.equal(outcome.rereadErrorMessage, null);
  assert.ok(outcome.diff !== null);
});

void test("a write that throws, followed by a re-read that also throws, still says so rather than collapsing to error", async () => {
  let composeCallCount = 0;
  const { client } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      if (composeCallCount === 1) {
        return Promise.resolve(composeDetail({ branch: "staging" }));
      }
      return Promise.reject(new Error("re-read also failed"));
    },
    updateComposeSettings: () => Promise.reject(new Error("timed out")),
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.equal(outcome.outcome, "write-status-unknown");
  if (outcome.outcome !== "write-status-unknown") throw new Error("unreachable");
  assert.equal(outcome.writeErrorMessage, "timed out");
  assert.equal(outcome.rereadErrorMessage, "re-read also failed");
  assert.equal(outcome.diff, null);
});

void test("error: getProjects fails outright", async () => {
  const { client } = stubClient({ getProjects: () => Promise.reject(new Error("network down")) });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, { outcome: "error", appDir: "api", errorMessage: "network down" });
});

void test("error: the initial getCompose fails outright", async () => {
  const { client } = stubClient({ getCompose: () => Promise.reject(new Error("dokploy said no")) });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, { outcome: "error", appDir: "api", errorMessage: "dokploy said no" });
});

void test("error: the post-write re-read after a successful write fails outright", async () => {
  let composeCallCount = 0;
  const { client } = stubClient({
    getCompose: () => {
      composeCallCount += 1;
      if (composeCallCount === 1) {
        return Promise.resolve(composeDetail({ branch: "staging" }));
      }
      return Promise.reject(new Error("post-write read failed"));
    },
  });

  const outcome = await applyAppSettings(client, DESIRED, "api");

  assert.deepEqual(outcome, {
    outcome: "error",
    appDir: "api",
    errorMessage: "post-write read failed",
  });
});
