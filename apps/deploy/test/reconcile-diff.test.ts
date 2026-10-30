import assert from "node:assert/strict";
import test from "node:test";

import type { DeployDesiredService } from "@unimatrix/deploy-config";

import { diffApp, findComposeMatches } from "../src/reconcile/diff.js";
import type { DokployCompose, DokployProject } from "../src/dokploy/schemas.js";

function desiredService(overrides: Partial<DeployDesiredService> = {}): DeployDesiredService {
  return {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-api",
    containerPort: 3001,
    env: [
      { name: "IMAGE_TAG", required: true },
      { name: "CLERK_SECRET_KEY", required: true },
      { name: "TRUST_PROXY", required: false },
    ],
    buildArgNames: [],
    publicStatus: true,
    ...overrides,
  };
}

function composeDetail(overrides: Partial<DokployCompose> = {}): DokployCompose {
  return {
    composeId: "compose-1",
    name: "api",
    environmentId: "env-1",
    composePath: "infra/docker/api-compose.yaml",
    sourceType: "github",
    branch: "main",
    autoDeploy: false,
    owner: "unimatrixcore",
    repository: "unimatrix-01",
    env: [],
    ...overrides,
  };
}

function project(
  name: string,
  composeEntries: { name: string; composeId: string }[],
): DokployProject {
  return {
    projectId: `project-${name}`,
    name,
    environments: [
      {
        environmentId: "env-1",
        name: "production",
        compose: composeEntries.map((entry) => ({
          composeId: entry.composeId,
          composeStatus: "done",
          name: entry.name,
        })),
      },
    ],
  };
}

void test("findComposeMatches: zero matches", () => {
  const matches = findComposeMatches("api", [
    project("Unimatrix-01", [{ name: "web", composeId: "c1" }]),
  ]);
  assert.deepEqual(matches, []);
});

void test("findComposeMatches: exactly one match", () => {
  const matches = findComposeMatches("api", [
    project("Unimatrix-01", [{ name: "api", composeId: "c1" }]),
  ]);
  assert.deepEqual(matches, [{ projectId: "project-Unimatrix-01", composeId: "c1" }]);
});

void test("findComposeMatches: matches globally across projects, not scoped to one", () => {
  const matches = findComposeMatches("api", [
    project("Unimatrix-01", [{ name: "api", composeId: "c1" }]),
    project("Faunova Studios", [{ name: "api", composeId: "c2" }]),
  ]);
  assert.equal(matches.length, 2);
});

void test("diffApp: missing verdict when there are zero matches", () => {
  const diff = diffApp(desiredService(), [], null);
  assert.deepEqual(diff, { verdict: "missing", appDir: "api" });
});

void test("diffApp: ambiguous verdict when there is more than one match", () => {
  const matches = [
    { projectId: "p1", composeId: "c1" },
    { projectId: "p2", composeId: "c2" },
  ];
  const diff = diffApp(desiredService(), matches, null);
  assert.deepEqual(diff, { verdict: "ambiguous", appDir: "api", matchCount: 2 });
});

void test("diffApp: throws if exactly one match but no detail was supplied", () => {
  assert.throws(
    () => diffApp(desiredService(), [{ projectId: "p1", composeId: "c1" }], null),
    /no compose detail was supplied/,
  );
});

const ONE_MATCH = [{ projectId: "p1", composeId: "c1" }];

void test("diffApp env state: set (present, non-blank)", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
    ONE_MATCH,
    composeDetail({ env: [{ key: "IMAGE_TAG", blank: false }] }),
  );
  assert.equal(diff.verdict, "matched");
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [{ key: "IMAGE_TAG", state: "set" }]);
  assert.equal(diff.inSync, true);
});

void test("diffApp env state: blank (present, empty value)", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
    ONE_MATCH,
    composeDetail({ env: [{ key: "IMAGE_TAG", blank: true }] }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [{ key: "IMAGE_TAG", state: "blank" }]);
  assert.equal(diff.inSync, false);
});

void test("diffApp env state: missing (required, absent from Dokploy)", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
    ONE_MATCH,
    composeDetail({ env: [] }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [{ key: "IMAGE_TAG", state: "missing" }]);
  assert.equal(diff.inSync, false);
});

void test("diffApp env state: optional-absent (not required, absent from Dokploy) is in sync", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "TRUST_PROXY", required: false }] }),
    ONE_MATCH,
    composeDetail({ env: [] }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [{ key: "TRUST_PROXY", state: "optional-absent" }]);
  assert.equal(diff.inSync, true);
});

void test("diffApp env state: undeclared (a Dokploy key the manifest never names)", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
    ONE_MATCH,
    composeDetail({
      env: [
        { key: "IMAGE_TAG", blank: false },
        { key: "HAND_EDITED_AT_2AM", blank: false },
      ],
    }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [
    { key: "HAND_EDITED_AT_2AM", state: "undeclared" },
    { key: "IMAGE_TAG", state: "set" },
  ]);
  assert.equal(diff.inSync, false);
});

void test("diffApp classifies a declared image build arg's runtime copy without hiding other drift", () => {
  const diff = diffApp(
    desiredService({
      env: [{ name: "IMAGE_TAG", required: true }],
      buildArgNames: ["VITE_API_BASE_URL"],
    }),
    ONE_MATCH,
    composeDetail({
      env: [
        { key: "IMAGE_TAG", blank: false },
        { key: "VITE_API_BASE_URL", blank: false },
        { key: "UNDECLARED_KEY", blank: false },
      ],
    }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.envFindings, [
    { key: "IMAGE_TAG", state: "set" },
    { key: "UNDECLARED_KEY", state: "undeclared" },
    { key: "VITE_API_BASE_URL", state: "build-arg-runtime-copy" },
  ]);
  assert.equal(diff.inSync, false);
});

void test("diffApp treats only present build-arg runtime copies as informational", () => {
  const desired = desiredService({
    env: [{ name: "IMAGE_TAG", required: true }],
    buildArgNames: ["VITE_API_BASE_URL"],
  });
  const diff = diffApp(
    desired,
    ONE_MATCH,
    composeDetail({
      env: [
        { key: "IMAGE_TAG", blank: false },
        { key: "VITE_API_BASE_URL", blank: true },
      ],
    }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.equal(diff.inSync, true);
  assert.deepEqual(diff.envFindings, [
    { key: "IMAGE_TAG", state: "set" },
    { key: "VITE_API_BASE_URL", state: "build-arg-runtime-copy" },
  ]);

  const absent = diffApp(
    desired,
    ONE_MATCH,
    composeDetail({ env: [{ key: "IMAGE_TAG", blank: false }] }),
  );
  if (absent.verdict !== "matched") throw new Error("unreachable");
  assert.equal(absent.inSync, true);
  assert.deepEqual(absent.envFindings, [{ key: "IMAGE_TAG", state: "set" }]);
});

void test("diffApp setting finding: composePath", () => {
  const diff = diffApp(
    desiredService({ env: [] }),
    ONE_MATCH,
    composeDetail({ composePath: "infra/docker/other-compose.yaml" }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, [
    {
      setting: "composePath",
      declared: "infra/docker/api-compose.yaml",
      actual: "infra/docker/other-compose.yaml",
    },
  ]);
  assert.equal(diff.inSync, false);
});

void test("diffApp normalises a leading ./ on the actual composePath before comparing", () => {
  const diff = diffApp(
    desiredService({ env: [] }),
    ONE_MATCH,
    composeDetail({ composePath: "./infra/docker/api-compose.yaml" }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, []);
  assert.equal(diff.inSync, true);
});

void test("diffApp setting finding: sourceType", () => {
  const diff = diffApp(
    desiredService({ env: [] }),
    ONE_MATCH,
    composeDetail({ sourceType: "raw" }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, [
    { setting: "sourceType", declared: "github", actual: "raw" },
  ]);
});

void test("diffApp setting finding: branch", () => {
  const diff = diffApp(
    desiredService({ env: [] }),
    ONE_MATCH,
    composeDetail({ branch: "staging" }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, [
    { setting: "branch", declared: "main", actual: "staging" },
  ]);
});

void test("diffApp setting finding: branch reports (unset) for a null branch", () => {
  const diff = diffApp(desiredService({ env: [] }), ONE_MATCH, composeDetail({ branch: null }));
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, [
    { setting: "branch", declared: "main", actual: "(unset)" },
  ]);
});

void test("diffApp setting finding: autoDeploy true is drift", () => {
  const diff = diffApp(desiredService({ env: [] }), ONE_MATCH, composeDetail({ autoDeploy: true }));
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, [
    { setting: "autoDeploy", declared: "false", actual: "true" },
  ]);
  assert.equal(diff.inSync, false);
});

void test("diffApp treats autoDeploy: null the same as off — not drift", () => {
  const diff = diffApp(desiredService({ env: [] }), ONE_MATCH, composeDetail({ autoDeploy: null }));
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.deepEqual(diff.settingFindings, []);
  assert.equal(diff.inSync, true);
});

void test("diffApp: inSync is true only when every env finding and every setting finding agree", () => {
  const diff = diffApp(
    desiredService({ env: [{ name: "IMAGE_TAG", required: true }] }),
    ONE_MATCH,
    composeDetail({ env: [{ key: "IMAGE_TAG", blank: false }] }),
  );
  if (diff.verdict !== "matched") throw new Error("unreachable");
  assert.equal(diff.inSync, true);
});
