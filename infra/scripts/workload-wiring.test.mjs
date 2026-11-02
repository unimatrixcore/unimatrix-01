import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));

test("root and workspace heavy scripts use the shared workload guard", () => {
  const directories = [root, join(root, "lab")];
  for (const parent of ["apps", "packages"])
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory()) directories.push(join(root, parent, entry.name));

  for (const directory of directories) {
    const { scripts = {} } = manifest(directory);
    for (const [name, command] of Object.entries(scripts))
      if (["build", "lint", "test", "typecheck", "check", "verify"].includes(name.split(":")[0])) {
        if (name.startsWith("check:") && name !== "check:ci") continue;
        assert.match(
          command,
          /^node (?:\.\/|\.\.\/)+infra\/scripts\/run-local-workload\.mjs -- /u,
          `${directory}: ${name}`,
        );
      }
  }
});

test("generated Docker build stages provide the guard before running package scripts", () => {
  for (const entry of readdirSync(join(root, "apps"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let dockerfile;
    try {
      dockerfile = readFileSync(join(root, "apps", entry.name, "Dockerfile"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const stage = dockerfile.slice(dockerfile.indexOf("FROM base AS build"));
    const copy = stage.indexOf(
      "COPY infra/scripts/run-local-workload.mjs ./infra/scripts/run-local-workload.mjs",
    );
    assert.ok(copy >= 0 && copy < stage.indexOf("RUN pnpm install"), entry.name);
    assert.ok(stage.indexOf("ENV UNIMATRIX_CONTAINER_BUILD=1") < copy, entry.name);
  }
});

test("Turbo preserves workload ownership and hosted build context for nested scripts", () => {
  const config = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
  for (const name of [
    "UNIMATRIX_LOCAL_WORKLOAD",
    "UNIMATRIX_CONTAINER_BUILD",
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
  ])
    assert.ok(config.globalPassThroughEnv.includes(name), name);
});
