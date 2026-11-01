import assert from "node:assert/strict";
import test from "node:test";

import { dokployComposeSchema } from "../src/dokploy/schemas.js";
import { readServiceMetadata } from "../src/observe/service-metadata.js";

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

void test("domain metadata cannot smuggle credentials or alternate link origins", () => {
  for (const domain of [
    { host: "user@evil.test" },
    { host: "example.com/evil" },
    { host: "example.com:443" },
    { path: "//evil.test" },
    { path: "/\\evil.test" },
    { path: "javascript:alert(1)" },
  ])
    assert.equal(
      dokployComposeSchema.safeParse({
        ...compose,
        domains: [{ ...compose.domains[0], ...domain }],
      }).success,
      false,
    );
});
