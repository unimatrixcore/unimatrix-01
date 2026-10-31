import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { openServiceTokenStore, type ServiceTokenStore } from "../service-tokens/store.js";

const USAGE =
  "Usage: token issue --name <caller> --capability <read|manage> | token list | token revoke --name <caller>";
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const capabilitySchema = z.enum(["read", "manage"]);

export interface ServiceTokenCliDeps {
  store: ServiceTokenStore;
  write(line: string): void;
}

export function runServiceTokenCli(argv: readonly string[], deps: ServiceTokenCliDeps): number {
  if (argv.length === 1 && argv[0] === "list") {
    deps.write(JSON.stringify(deps.store.list()));
    return 0;
  }
  if (argv[0] === "issue" && argv.length === 5) {
    const flags = new Map<string, string>();
    for (let index = 1; index < argv.length; index += 2) {
      const key = argv[index];
      const value = argv[index + 1];
      if ((key !== "--name" && key !== "--capability") || value === undefined || flags.has(key)) {
        deps.write(USAGE);
        return 2;
      }
      flags.set(key, value);
    }
    const name = nameSchema.safeParse(flags.get("--name"));
    const capability = capabilitySchema.safeParse(flags.get("--capability"));
    if (name.success && capability.success) {
      deps.write(deps.store.issue({ name: name.data, capability: capability.data }).token);
      return 0;
    }
  }
  if (argv[0] === "revoke" && argv.length === 3 && argv[1] === "--name") {
    const name = nameSchema.safeParse(argv[2]);
    if (name.success) {
      const revoked = deps.store.revoke(name.data);
      deps.write(
        revoked === null
          ? "No active deploy service token uses that name."
          : "Deploy service token revoked.",
      );
      return revoked === null ? 1 : 0;
    }
  }
  deps.write(USAGE);
  return 2;
}

function main(): void {
  let store: ServiceTokenStore | undefined;
  try {
    const path = process.env.DEPLOY_DATABASE_PATH ?? "local/deploy.sqlite";
    if (path.trim().length === 0) throw new Error("Invalid database path.");
    store = openServiceTokenStore(path);
    process.exitCode = runServiceTokenCli(process.argv.slice(2), {
      store,
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    });
  } catch {
    process.stderr.write("Deploy service token command failed.\n");
    process.exitCode = 2;
  } finally {
    store?.close();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
