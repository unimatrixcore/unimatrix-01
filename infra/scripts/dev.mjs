import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapLocalEnvFiles, printBootstrapLocalEnvFiles } from "./setup-local.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_NODE_MAJOR = "22";
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function ensureSupportedNodeVersion() {
  const nodeMajor = process.versions.node.split(".")[0];

  if (nodeMajor === REQUIRED_NODE_MAJOR) {
    return;
  }

  console.error(
    `pnpm dev requires Node ${REQUIRED_NODE_MAJOR}.x. See .node-version or run ./infra/scripts/pnpm-with-node22.sh dev.`,
  );
  process.exit(1);
}

function ensureWorkspaceDependenciesInstalled() {
  const nodeModulesPath = resolve(REPO_ROOT, "node_modules");
  const turboPackagePath = resolve(REPO_ROOT, "node_modules/turbo/package.json");

  if (existsSync(nodeModulesPath) && existsSync(turboPackagePath)) {
    return;
  }

  console.error(
    "Workspace dependencies are not installed. Run `pnpm install` from the repo root before `pnpm dev`.",
  );
  process.exit(1);
}

async function main() {
  ensureSupportedNodeVersion();
  ensureWorkspaceDependenciesInstalled();

  try {
    const bootstrapResults = await bootstrapLocalEnvFiles();
    printBootstrapLocalEnvFiles(bootstrapResults);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const child = spawn(
    PNPM_COMMAND,
    [
      "exec",
      "turbo",
      "run",
      "dev",
      "--parallel",
      "--filter=@unimatrix/api",
      "--filter=@unimatrix/web",
    ],
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
    },
  );

  child.on("error", (error) => {
    console.error(`Failed to start pnpm dev workflow: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

await main();
