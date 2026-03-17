import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  bootstrapLocalEnvFiles,
  printBootstrapLocalEnvFiles,
} from "./setup-local.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const PLAYWRIGHT_INSTALL_ARGS = [
  "--filter",
  "@unimatrix/web",
  "exec",
  "playwright",
  "install",
  "--with-deps",
  "chromium",
];

function parseOptions(argv = process.argv.slice(2)) {
  const options = {
    installPlaywright: false,
  };

  for (const argument of argv) {
    if (argument === "--") {
      continue;
    }

    if (argument === "--with-playwright") {
      options.installPlaywright = true;
      continue;
    }

    if (argument === "--help") {
      console.log("Usage: pnpm setup:worktree [--with-playwright]");
      console.log(
        "Bootstraps a fresh worktree by installing dependencies, creating local env files, and running database migrations.",
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function runPnpmCommand(args, label) {
  return new Promise((resolve, reject) => {
    console.log(`Running ${label}`);

    const child = spawn(PNPM_COMMAND, args, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${label}: ${error.message}`, {
        cause: error,
      }));
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited from signal ${signal}.`));
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} exited with code ${code ?? 1}.`));
    });
  });
}

function printSetupWarnings() {
  if (Object.hasOwn(process.env, "DATABASE_URL")) {
    console.warn(
      "Warning: DATABASE_URL is set in the current shell, so this worktree may not use packages/db/local/unimatrix.sqlite.",
    );
  }

  console.log(
    "If you run multiple worktrees at once, update apps/api/.env and apps/web/.env to avoid local port collisions.",
  );
}

async function main() {
  const options = parseOptions();

  await runPnpmCommand(
    ["install", "--frozen-lockfile"],
    "pnpm install --frozen-lockfile",
  );

  const bootstrapResults = await bootstrapLocalEnvFiles();
  printBootstrapLocalEnvFiles(bootstrapResults);
  printSetupWarnings();

  await runPnpmCommand(["db:migrate"], "pnpm db:migrate");

  if (options.installPlaywright) {
    await runPnpmCommand(
      PLAYWRIGHT_INSTALL_ARGS,
      "pnpm --filter @unimatrix/web exec playwright install --with-deps chromium",
    );
  }

  console.log("Worktree setup complete.");
  console.log("Next: pnpm dev");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
