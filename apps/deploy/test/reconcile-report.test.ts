import assert from "node:assert/strict";
import test from "node:test";

import type { DeployDesiredState } from "@unimatrix/deploy-config";

import type { ApplyOutcome } from "../src/reconcile/apply.js";
import { createDokployClient, type DokployClient } from "../src/dokploy/client.js";
import { collectReconcileRun } from "../src/reconcile/collect.js";
import { renderApplyOutcome, renderReconcileRun } from "../src/reconcile/report.js";
import type { ReconcileRun } from "../src/reconcile/collect.js";

const BASE_URL = "http://dokploy:3000";
const API_KEY = "dokploy_test_key";
const CANARY = "sk_live_CANARY_DO_NOT_PRINT";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ONE_APP_DESIRED: DeployDesiredState = [
  {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-api",
    containerPort: 3001,
    env: [
      { name: "IMAGE_TAG", required: true },
      { name: "CLERK_SECRET_KEY", required: true },
    ],
    buildArgNames: [],
    publicStatus: true,
  },
];

const PROJECTS_BODY = [
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

function clientWithComposeEnv(env: string): DokployClient {
  return createDokployClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: (url) => {
      // callProcedure always passes a URL instance.
      const target = (url as URL).toString();

      if (target.includes("project.all")) {
        return Promise.resolve(jsonResponse(PROJECTS_BODY));
      }

      return Promise.resolve(
        jsonResponse({
          composeId: "compose-1",
          name: "api",
          environmentId: "env-1",
          composePath: "infra/docker/api-compose.yaml",
          sourceType: "github",
          branch: "main",
          autoDeploy: false,
          owner: "unimatrixcore",
          repository: "unimatrix-01",
          env,
        }),
      );
    },
  });
}

async function runWithEnv(
  env: string,
): Promise<{ run: ReconcileRun; rendered: readonly string[] }> {
  const client = clientWithComposeEnv(env);
  const run = await collectReconcileRun(client, ONE_APP_DESIRED);
  const rendered = renderReconcileRun(run);

  return { run, rendered };
}

void test("canary: a plaintext secret in Dokploy's env blob never reaches JSON.stringify(run)", async () => {
  const { run } = await runWithEnv(`CLERK_SECRET_KEY=${CANARY}\nHAND_EDITED_AT_2AM=value\n`);

  assert.ok(!JSON.stringify(run).includes(CANARY));
});

void test("canary: a plaintext secret in Dokploy's env blob never reaches the rendered report", async () => {
  const { rendered } = await runWithEnv(`CLERK_SECRET_KEY=${CANARY}\nHAND_EDITED_AT_2AM=value\n`);
  const joined = rendered.join("\n");

  assert.ok(!joined.includes(CANARY));
});

void test("an undeclared key IS reported by name, just never by value", async () => {
  const { rendered } = await runWithEnv(`CLERK_SECRET_KEY=${CANARY}\nHAND_EDITED_AT_2AM=value\n`);
  const joined = rendered.join("\n");

  assert.ok(joined.includes("HAND_EDITED_AT_2AM"));
  assert.ok(joined.includes("undeclared"));
});

void test("renders MISSING for a declared app with no matching Dokploy compose service", async () => {
  const client = createDokployClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () => Promise.resolve(jsonResponse([])),
  });

  const run = await collectReconcileRun(client, ONE_APP_DESIRED);
  const rendered = renderReconcileRun(run);

  assert.deepEqual(rendered, ['api: MISSING — no Dokploy compose service named "api"']);
});

void test("renders AMBIGUOUS when more than one Dokploy compose service shares the name", async () => {
  const projects = [
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
  const client = createDokployClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () => Promise.resolve(jsonResponse(projects)),
  });

  const run = await collectReconcileRun(client, ONE_APP_DESIRED);
  const rendered = renderReconcileRun(run);

  assert.deepEqual(rendered, ['api: AMBIGUOUS — 2 Dokploy compose services named "api"']);
});

void test("renders IN SYNC when every env and setting finding matches", async () => {
  const { rendered } = await runWithEnv(`CLERK_SECRET_KEY=set-value\nIMAGE_TAG=abc123\n`);

  assert.deepEqual(rendered, ["api: IN SYNC"]);
});

void test("reports build-arg runtime copies separately without exposing their values or calling them drift", async () => {
  const desired: DeployDesiredState = [
    { ...ONE_APP_DESIRED[0]!, buildArgNames: ["VITE_API_BASE_URL"] },
  ];
  const run = await collectReconcileRun(
    clientWithComposeEnv(
      `CLERK_SECRET_KEY=${CANARY}\nIMAGE_TAG=abc123\nVITE_API_BASE_URL=${CANARY}\n`,
    ),
    desired,
  );
  const rendered = renderReconcileRun(run).join("\n");

  assert.match(rendered, /^api: IN SYNC/mu);
  assert.match(rendered, /^api: BUILD ARG RUNTIME COPIES$/mu);
  assert.match(rendered, /env VITE_API_BASE_URL: build arg runtime copy/mu);
  assert.ok(!rendered.includes(CANARY));
});

void test("places build-arg copies outside the actionable drift lines", async () => {
  const desired: DeployDesiredState = [
    { ...ONE_APP_DESIRED[0]!, buildArgNames: ["VITE_API_BASE_URL"] },
  ];
  const run = await collectReconcileRun(
    clientWithComposeEnv("IMAGE_TAG=abc123\nVITE_API_BASE_URL=ignored\n"),
    desired,
  );

  assert.deepEqual(renderReconcileRun(run), [
    "api: DRIFT",
    "  env CLERK_SECRET_KEY: missing",
    "api: BUILD ARG RUNTIME COPIES",
    "  env VITE_API_BASE_URL: build arg runtime copy (ignored; value is baked into image)",
  ]);
});

void test("a Dokploy compose service the repo declares nowhere is simply never reported", async () => {
  const projects = [
    {
      projectId: "project-1",
      name: "Smart Home",
      environments: [
        {
          environmentId: "env-1",
          name: "production",
          compose: [{ composeId: "compose-9", composeStatus: "done", name: "home-assistant" }],
        },
      ],
    },
  ];
  const client = createDokployClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () => Promise.resolve(jsonResponse(projects)),
  });

  // ONE_APP_DESIRED declares only "api" — reconcile is desired-state-driven, so the
  // "home-assistant" service above is invisible to it, and "api" is reported missing.
  const run = await collectReconcileRun(client, ONE_APP_DESIRED);
  const rendered = renderReconcileRun(run);

  assert.deepEqual(rendered, ['api: MISSING — no Dokploy compose service named "api"']);
});

void test("renders ERROR when compose.one fails, isolated to that app", async () => {
  const client = createDokployClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: (url) => {
      // callProcedure always passes a URL instance.
      const target = (url as URL).toString();

      if (target.includes("project.all")) {
        return Promise.resolve(jsonResponse(PROJECTS_BODY));
      }

      return Promise.resolve(jsonResponse({ message: "boom" }, 500));
    },
  });

  const run = await collectReconcileRun(client, ONE_APP_DESIRED);
  const rendered = renderReconcileRun(run);

  assert.equal(rendered.length, 1);
  assert.ok(rendered[0]?.startsWith("api: ERROR — "));
});

const MATCHED_IN_SYNC = {
  verdict: "matched",
  appDir: "api",
  composeId: "compose-1",
  envFindings: [{ key: "IMAGE_TAG", state: "set" }],
  settingFindings: [],
  inSync: true,
} as const;

const MATCHED_WITH_ENV_DRIFT = {
  verdict: "matched",
  appDir: "api",
  composeId: "compose-1",
  envFindings: [
    { key: "IMAGE_TAG", state: "set" },
    { key: "CLERK_SECRET_KEY", state: "missing" },
  ],
  settingFindings: [],
  inSync: false,
} as const;

void test("renderApplyOutcome: applied says apply never writes env and lists non-in-sync env findings", () => {
  const outcome: ApplyOutcome = {
    outcome: "applied",
    appDir: "api",
    written: ["branch"],
    needsDeploy: true,
    diff: MATCHED_WITH_ENV_DRIFT,
  };

  const rendered = renderApplyOutcome(outcome).join("\n");

  assert.ok(rendered.includes("APPLIED"));
  assert.ok(rendered.includes("apply never writes env"));
  assert.ok(rendered.includes("CLERK_SECRET_KEY"));
  assert.ok(rendered.includes("missing"));
  assert.ok(rendered.includes("deploy is required"));
});

void test("renderApplyOutcome: applied with no residual env drift prints only the summary line", () => {
  const outcome: ApplyOutcome = {
    outcome: "applied",
    appDir: "api",
    written: ["autoDeploy"],
    needsDeploy: false,
    diff: MATCHED_IN_SYNC,
  };

  const rendered = renderApplyOutcome(outcome);

  assert.equal(rendered.length, 1);
  assert.ok(rendered[0]?.includes("apply never writes env"));
  assert.ok(!rendered[0]?.includes("deploy is required"));
});

void test("renderApplyOutcome: nothing-to-apply says apply never writes env and lists env drift", () => {
  const outcome: ApplyOutcome = {
    outcome: "nothing-to-apply",
    appDir: "api",
    diff: MATCHED_WITH_ENV_DRIFT,
  };

  const rendered = renderApplyOutcome(outcome).join("\n");

  assert.ok(rendered.includes("NOTHING TO APPLY"));
  assert.ok(rendered.includes("apply never writes env"));
  assert.ok(rendered.includes("CLERK_SECRET_KEY"));
});

void test("renderApplyOutcome: refused-self, unknown-app, not-matched, refused-foreign-repo, refused-source-type each render one line", () => {
  const outcomes: ApplyOutcome[] = [
    { outcome: "refused-self", appDir: "deploy" },
    { outcome: "unknown-app", appDir: "ghost" },
    { outcome: "not-matched", appDir: "api", matchCount: 0 },
    { outcome: "refused-foreign-repo", appDir: "api", owner: "someone-else", repository: "fork" },
    { outcome: "refused-source-type", appDir: "api" },
  ];

  for (const outcome of outcomes) {
    const rendered = renderApplyOutcome(outcome);
    assert.equal(rendered.length, 1);
    assert.ok(rendered[0]?.startsWith(outcome.appDir));
  }
});

void test("renderApplyOutcome: write-status-unknown with an observed re-read shows the observed diff", () => {
  const outcome: ApplyOutcome = {
    outcome: "write-status-unknown",
    appDir: "api",
    diff: MATCHED_WITH_ENV_DRIFT,
    writeErrorMessage: "request timed out",
    rereadErrorMessage: null,
  };

  const rendered = renderApplyOutcome(outcome).join("\n");

  assert.ok(rendered.includes("WRITE STATUS UNKNOWN"));
  assert.ok(rendered.includes("request timed out"));
  assert.ok(rendered.includes("CLERK_SECRET_KEY"));
});

void test("renderApplyOutcome: write-status-unknown with an in-sync re-read says so, rather than trailing off", () => {
  const outcome: ApplyOutcome = {
    outcome: "write-status-unknown",
    appDir: "api",
    diff: MATCHED_IN_SYNC,
    writeErrorMessage: "request timed out",
    rereadErrorMessage: null,
  };

  const rendered = renderApplyOutcome(outcome);

  assert.equal(rendered.length, 2);
  assert.ok(rendered[0]?.includes("WRITE STATUS UNKNOWN"));
  assert.ok(rendered[1]?.includes("in sync"));
});

void test("renderApplyOutcome: write-status-unknown with a failed re-read says the re-read also failed", () => {
  const outcome: ApplyOutcome = {
    outcome: "write-status-unknown",
    appDir: "api",
    diff: null,
    writeErrorMessage: "request timed out",
    rereadErrorMessage: "re-read failed too",
  };

  const rendered = renderApplyOutcome(outcome).join("\n");

  assert.ok(rendered.includes("request timed out"));
  assert.ok(rendered.includes("re-read failed too"));
});

void test("renderApplyOutcome: error prints the message only", () => {
  const outcome: ApplyOutcome = { outcome: "error", appDir: "api", errorMessage: "network down" };

  const rendered = renderApplyOutcome(outcome);

  assert.deepEqual(rendered, ["api: ERROR — network down"]);
});
