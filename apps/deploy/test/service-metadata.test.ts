import assert from "node:assert/strict";
import test from "node:test";

import { dokployComposeSchema } from "../src/dokploy/schemas.js";
import {
  createServiceMetadataReader,
  readServiceMetadata,
} from "../src/observe/service-metadata.js";

const compose = {
  composeId: "compose/id",
  name: "api",
  environmentId: "env/id",
  composePath: "compose.yaml",
  sourceType: "github",
  branch: "main",
  autoDeploy: false,
  owner: "unimatrixcore",
  repository: "unimatrix-01",
  env: "TOKEN=sensitive-value",
  domains: [
    { host: "api.example.com", https: true, port: 3001, path: "/api", password: "must-strip" },
  ],
};
const project = {
  projectId: "project/id",
  name: "Project",
  environments: [
    {
      environmentId: "env/id",
      name: "Environment",
      compose: [{ composeId: "compose/id", name: "api", composeStatus: "done" }],
    },
  ],
};

void test("service metadata uses unique observed mapping and an explicit public origin", async () => {
  const parsed = dokployComposeSchema.parse(compose);
  const metadata = await readServiceMetadata(
    { getProjects: () => Promise.resolve([project]), getCompose: () => Promise.resolve(parsed) },
    ["api"],
    "https://dokploy.example",
    () => 100,
  );
  assert.deepEqual(metadata.get("api"), {
    dokployUrl:
      "https://dokploy.example/dashboard/project/project%2Fid/environment/env%2Fid/services/compose/compose%2Fid",
    domains: [{ host: "api.example.com", https: true, port: 3001, path: "/api" }],
    primaryDomain: { host: "api.example.com", https: true, port: 3001, path: "/api" },
    metadataObservedAt: 100,
    metadataFreshness: "fresh",
  });
  assert.equal(JSON.stringify([...metadata.values()]).includes("sensitive-value"), false);
  const unconfigured = await readServiceMetadata(
    { getProjects: () => Promise.resolve([project]), getCompose: () => Promise.resolve(parsed) },
    ["api"],
    null,
  );
  assert.equal(unconfigured.get("api")?.dokployUrl, null);
});

void test("cflop primary domain follows explicit policy independently of Dokploy order", async () => {
  const primary = { host: "cflop.us", https: false, port: 8080, path: "/cube" };
  const compatibility = [
    { ...primary, host: "cflop.unimatrix-01.dev", https: true, path: "/" },
    { ...primary, host: "cube.unimatrix-01.dev", https: true, path: "/" },
  ];
  const cflopProject = {
    ...project,
    environments: [
      {
        ...project.environments[0]!,
        compose: [{ composeId: "compose/id", name: "cflop", composeStatus: "done" }],
      },
    ],
  };
  for (const domains of [
    [...compatibility, primary],
    [primary, ...compatibility.toReversed()],
    [compatibility[0]!, { ...primary, host: "CFLOP.US" }, compatibility[1]!],
    compatibility,
    [],
    null,
  ]) {
    const parsed = dokployComposeSchema.parse({ ...compose, name: "cflop", domains });
    const metadata = await readServiceMetadata(
      {
        getProjects: () => Promise.resolve([cflopProject]),
        getCompose: () => Promise.resolve(parsed),
      },
      ["cflop"],
      null,
    );
    const value = metadata.get("cflop");
    assert.deepEqual(value?.domains, domains);
    assert.deepEqual(
      value?.primaryDomain,
      domains?.find((domain) => domain.host.toLowerCase() === "cflop.us") ?? null,
    );
  }
});

void test("unconfigured applications preserve first-domain fallback and unavailable domains", async () => {
  for (const domains of [
    [
      { host: "api.example.com", https: true, port: 3001, path: "/api" },
      { host: "other.example.com", https: false, port: 3001, path: null },
    ],
    [],
    null,
  ]) {
    const parsed = dokployComposeSchema.parse({ ...compose, domains });
    const metadata = await readServiceMetadata(
      { getProjects: () => Promise.resolve([project]), getCompose: () => Promise.resolve(parsed) },
      ["api"],
      null,
    );
    assert.deepEqual(metadata.get("api")?.primaryDomain, domains?.[0] ?? null);
  }
});

void test("failed, ambiguous and mismatched reads remain unavailable", async () => {
  const parsed = dokployComposeSchema.parse(compose);
  for (const client of [
    {
      getProjects: () => Promise.reject(new Error("secret-upstream-value")),
      getCompose: () => Promise.resolve(parsed),
    },
    {
      getProjects: () => Promise.resolve([project, project]),
      getCompose: () => Promise.resolve(parsed),
    },
    {
      getProjects: () => Promise.resolve([project]),
      getCompose: () => Promise.resolve({ ...parsed, composeId: "other" }),
    },
    {
      getProjects: () => Promise.resolve([project]),
      getCompose: () => Promise.resolve({ ...parsed, owner: "foreign-owner" }),
    },
    {
      getProjects: () => Promise.resolve([project]),
      getCompose: () => Promise.reject(new Error("secret-upstream-value")),
    },
  ])
    assert.equal((await readServiceMetadata(client, ["api"], "https://dokploy.example")).size, 0);
});

void test("invalid optional domains stay unavailable without discarding service metadata", async () => {
  for (const domain of [
    { host: "user@evil.test" },
    { host: "example.com/evil" },
    { host: "example.com:443" },
    { path: "//evil.test" },
    { path: "/\\evil.test" },
    { path: "javascript:alert(1)" },
  ]) {
    const parsed = dokployComposeSchema.parse({
      ...compose,
      domains: [{ ...compose.domains[0], ...domain }],
    });
    assert.equal(parsed.domains, null);
    const metadata = await readServiceMetadata(
      { getProjects: () => Promise.resolve([project]), getCompose: () => Promise.resolve(parsed) },
      ["api"],
      "https://dokploy.example",
      () => 100,
    );
    assert.equal(metadata.get("api")?.domains, null);
    assert.equal(metadata.get("api")?.primaryDomain, null);
    assert.equal(
      metadata.get("api")?.dokployUrl,
      "https://dokploy.example/dashboard/project/project%2Fid/environment/env%2Fid/services/compose/compose%2Fid",
    );
    assert.equal(metadata.get("api")?.metadataFreshness, "fresh");
  }
});

void test("metadata budget returns cached data and coalesces stalled refreshes", async () => {
  let now = 100;
  let calls = 0;
  let resume: (() => void) | undefined;
  const parsed = dokployComposeSchema.parse(compose);
  const reader = createServiceMetadataReader(
    {
      getProjects: async () => {
        calls += 1;
        if (calls > 1)
          await new Promise<void>((resolve) => {
            resume = resolve;
          });
        return [project];
      },
      getCompose: () => Promise.resolve(parsed),
    },
    ["api"],
    "https://dokploy.example",
    { budgetMs: 5, refreshIntervalMs: 100, now: () => now },
  );
  assert.equal((await reader.read()).get("api")?.metadataFreshness, "fresh");
  now = 201;
  const stale = await reader.read();
  assert.equal(stale.get("api")?.metadataFreshness, "stale");
  assert.equal(stale.get("api")?.metadataObservedAt, 100);
  now = 1000;
  await Promise.all([reader.read(), reader.read(), reader.read()]);
  assert.equal(calls, 2);
  assert.ok(resume);
  resume();
  assert.equal((await reader.read()).get("api")?.metadataFreshness, "fresh");
  assert.equal(calls, 2);
});
