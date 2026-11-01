import assert from "node:assert/strict";
import test from "node:test";

import { loadDokployCreationConfig } from "../src/dokploy/creation-config.js";

void test("creation configuration accepts opaque Dokploy identifiers and trims spaces", () => {
  assert.deepEqual(
    loadDokployCreationConfig({
      DOKPLOY_GITHUB_ID: "provider",
      DOKPLOY_ENVIRONMENT_ID: "  prod_env-01  ",
    }),
    {
      environmentId: "prod_env-01",
      githubId: "provider",
    },
  );
  assert.equal(
    loadDokployCreationConfig({
      DOKPLOY_GITHUB_ID: "provider",
      DOKPLOY_ENVIRONMENT_ID: "x".repeat(256),
    }).environmentId.length,
    256,
  );
});

void test("creation configuration requires an explicitly configured environment", () => {
  for (const value of [undefined, "", "   "]) {
    assert.throws(
      () =>
        loadDokployCreationConfig({ DOKPLOY_GITHUB_ID: "provider", DOKPLOY_ENVIRONMENT_ID: value }),
      {
        message: "DOKPLOY_ENVIRONMENT_ID must be set for service creation.",
      },
    );
  }
});

void test("creation configuration rejects malformed identifiers without echoing input", () => {
  for (const value of [
    "sensitive environment",
    "sensitive\tidentifier",
    "sensitive\nidentifier",
    "sensitive\u0000identifier",
    "sensitive\u200bidentifier",
    "identifier\n",
    "x".repeat(257),
  ]) {
    assert.throws(
      () =>
        loadDokployCreationConfig({ DOKPLOY_GITHUB_ID: "provider", DOKPLOY_ENVIRONMENT_ID: value }),
      {
        message: "DOKPLOY_ENVIRONMENT_ID must be a valid opaque identifier.",
      },
    );
  }
});

void test("creation configuration reads the runtime environment only when called", () => {
  const previous = process.env.DOKPLOY_ENVIRONMENT_ID;
  const previousGithub = process.env.DOKPLOY_GITHUB_ID;
  try {
    process.env.DOKPLOY_ENVIRONMENT_ID = "runtime-environment";
    process.env.DOKPLOY_GITHUB_ID = "runtime-provider";
    assert.deepEqual(loadDokployCreationConfig(), {
      environmentId: "runtime-environment",
      githubId: "runtime-provider",
    });
  } finally {
    if (previousGithub === undefined) delete process.env.DOKPLOY_GITHUB_ID;
    else process.env.DOKPLOY_GITHUB_ID = previousGithub;
    if (previous === undefined) delete process.env.DOKPLOY_ENVIRONMENT_ID;
    else process.env.DOKPLOY_ENVIRONMENT_ID = previous;
  }
});

void test("creation requires an explicit valid GitHub provider without echoing its input", () => {
  for (const value of [undefined, "", " "]) {
    assert.throws(
      () => loadDokployCreationConfig({ DOKPLOY_ENVIRONMENT_ID: "env", DOKPLOY_GITHUB_ID: value }),
      {
        message: "DOKPLOY_GITHUB_ID must be set for service creation.",
      },
    );
  }
  for (const value of ["private provider", "provider\n", "x".repeat(257)]) {
    assert.throws(
      () => loadDokployCreationConfig({ DOKPLOY_ENVIRONMENT_ID: "env", DOKPLOY_GITHUB_ID: value }),
      {
        message: "DOKPLOY_GITHUB_ID must be a valid opaque identifier.",
      },
    );
  }
});
