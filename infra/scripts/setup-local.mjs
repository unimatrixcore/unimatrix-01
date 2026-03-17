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

    await copyFile(file.examplePath, file.targetPath);
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
  const results = await bootstrapLocalEnvFiles();
  printBootstrapLocalEnvFiles(results);
  console.log("Next: pnpm dev");
}

if (isMainModule()) {
  await main();
}
