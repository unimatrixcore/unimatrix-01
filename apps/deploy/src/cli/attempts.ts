import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  openDeploymentAttemptStore,
  type CancelUnusedCiReservationsInput,
  type DeploymentAttemptStore,
} from "../attempts/store.js";

const USAGE = "Usage: attempts cancel-unused --manifest <path>";

export interface DeploymentAttemptsCliDeps {
  store: DeploymentAttemptStore;
  readManifest(path: string): unknown;
  now(): number;
  write(line: string): void;
}

export function runDeploymentAttemptsCli(
  argv: readonly string[],
  deps: DeploymentAttemptsCliDeps,
): number {
  if (
    argv.length !== 3 ||
    argv[0] !== "cancel-unused" ||
    argv[1] !== "--manifest" ||
    !argv[2]?.trim()
  ) {
    deps.write(USAGE);
    return 2;
  }
  try {
    const input = deps.readManifest(argv[2]) as CancelUnusedCiReservationsInput;
    const records = deps.store.cancelUnusedCi(input, deps.now());
    deps.write(
      JSON.stringify({ cancelled: records.length, apps: records.map((record) => record.app) }),
    );
    return 0;
  } catch {
    deps.write("Unused CI reservation cancellation refused.");
    return 1;
  }
}

function main(): void {
  let store: DeploymentAttemptStore | undefined;
  try {
    const path = process.env.DEPLOY_DATABASE_PATH ?? "local/deploy.sqlite";
    if (!path.trim()) throw new Error("Invalid database path.");
    store = openDeploymentAttemptStore(path);
    process.exitCode = runDeploymentAttemptsCli(process.argv.slice(2), {
      store,
      readManifest: (manifestPath) => JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
      now: Date.now,
      write: (line) => process.stdout.write(`${line}\n`),
    });
  } catch {
    process.stderr.write("Deployment attempts command failed.\n");
    process.exitCode = 2;
  } finally {
    store?.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
