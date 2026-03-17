import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { loadApiLocalEnvFiles } from "../src/env.js";

const TEST_ENV_VARIABLE = "LOC54_API_ENV_TEST_VALUE";

async function createApiRootFixture(t: TestContext): Promise<string> {
  const apiRootDirectory = await mkdtemp(join(tmpdir(), "unimatrix-api-env-"));

  t.after(async () => {
    await rm(apiRootDirectory, { force: true, recursive: true });
  });

  return apiRootDirectory;
}

function trackProcessEnvVariable(t: TestContext, variableName: string): void {
  const originalValue = process.env[variableName];

  delete process.env[variableName];

  t.after(() => {
    if (originalValue === undefined) {
      delete process.env[variableName];
      return;
    }

    process.env[variableName] = originalValue;
  });
}

void test("loadApiLocalEnvFiles no-ops when local env files are missing", async (t) => {
  const apiRootDirectory = await createApiRootFixture(t);
  trackProcessEnvVariable(t, TEST_ENV_VARIABLE);

  loadApiLocalEnvFiles(apiRootDirectory);

  assert.equal(process.env[TEST_ENV_VARIABLE], undefined);
});

void test(".env.local wins over .env", async (t) => {
  const apiRootDirectory = await createApiRootFixture(t);
  trackProcessEnvVariable(t, TEST_ENV_VARIABLE);

  await writeFile(join(apiRootDirectory, ".env.local"), `${TEST_ENV_VARIABLE}=from-local\n`);
  await writeFile(join(apiRootDirectory, ".env"), `${TEST_ENV_VARIABLE}=from-env\n`);

  loadApiLocalEnvFiles(apiRootDirectory);

  assert.equal(process.env[TEST_ENV_VARIABLE], "from-local");
});

void test("existing environment variables win over file-loaded values", async (t) => {
  const apiRootDirectory = await createApiRootFixture(t);
  trackProcessEnvVariable(t, TEST_ENV_VARIABLE);

  process.env[TEST_ENV_VARIABLE] = "from-shell";

  await writeFile(join(apiRootDirectory, ".env.local"), `${TEST_ENV_VARIABLE}=from-local\n`);
  await writeFile(join(apiRootDirectory, ".env"), `${TEST_ENV_VARIABLE}=from-env\n`);

  loadApiLocalEnvFiles(apiRootDirectory);

  assert.equal(process.env[TEST_ENV_VARIABLE], "from-shell");
});

void test("malformed local env file content surfaces API-local context", async (t) => {
  const apiRootDirectory = await createApiRootFixture(t);
  trackProcessEnvVariable(t, TEST_ENV_VARIABLE);

  await writeFile(
    join(apiRootDirectory, ".env"),
    Buffer.from(`${TEST_ENV_VARIABLE}=from-env\u0000BROKEN=1`, "utf8"),
  );

  assert.throws(() => {
    loadApiLocalEnvFiles(apiRootDirectory);
  }, /Failed to load API local env file \.env: file must not contain NUL bytes\./u);
});
