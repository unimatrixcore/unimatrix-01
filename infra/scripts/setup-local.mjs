import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const LOCAL_ENV_FILES = [
  {
    examplePath: resolve(REPO_ROOT, "apps/api/.env.example"),
    targetPath: resolve(REPO_ROOT, "apps/api/.env"),
  },
  {
    examplePath: resolve(REPO_ROOT, "apps/web/.env.example"),
    targetPath: resolve(REPO_ROOT, "apps/web/.env"),
  },
];

function isMainModule() {
  if (process.argv[1] === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

function toRepoRelativePath(filePath) {
  return relative(REPO_ROOT, filePath).replaceAll("\\", "/");
}

function createBootstrapLocalEnvError(file, error) {
  const examplePath = toRepoRelativePath(file.examplePath);
  const targetPath = toRepoRelativePath(file.targetPath);

  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return new Error(
      `Cannot bootstrap ${targetPath}: example file ${examplePath} is missing.`,
      { cause: error },
    );
  }

  const message = error instanceof Error ? error.message : String(error);

  return new Error(`Cannot bootstrap ${targetPath}: ${message}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

export async function bootstrapLocalEnvFiles() {
  const results = [];

  for (const file of LOCAL_ENV_FILES) {
    if (existsSync(file.targetPath)) {
      results.push({
        ...file,
        status: "untouched",
      });
      continue;
    }

    try {
      await copyFile(file.examplePath, file.targetPath);
    } catch (error) {
      throw createBootstrapLocalEnvError(file, error);
    }

    results.push({
      ...file,
      status: "created",
    });
  }

  return results;
}

export function printBootstrapLocalEnvFiles(results) {
  for (const result of results) {
    const targetPath = toRepoRelativePath(result.targetPath);

    if (result.status === "created") {
      const examplePath = toRepoRelativePath(result.examplePath);
      console.log(`Created ${targetPath} from ${examplePath}`);
      continue;
    }

    console.log(`Left untouched ${targetPath}`);
  }
}

async function main() {
  try {
    const results = await bootstrapLocalEnvFiles();
    printBootstrapLocalEnvFiles(results);
    console.log("Next: pnpm dev");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

if (isMainModule()) {
  await main();
}
