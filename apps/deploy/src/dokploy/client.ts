import { createDokployTransport, type CreateDokployClientOptions } from "./transport.js";
export { DokployClientError, type CreateDokployClientOptions } from "./transport.js";
import {
  dokployComposeSchema,
  dokployContainersSchema,
  dokployProjectsSchema,
  dokployVersionSchema,
  type DokployCompose,
  type DokployContainer,
  type DokployProject,
  type DokployVersion,
} from "./schemas.js";

export interface DeployDokployEnv {
  DOKPLOY_API_KEY?: string | undefined;
}

/**
 * Throws on an absent or empty key rather than returning `undefined` — a caller that forgets to
 * check a nullable return is exactly how a key silently never reaches the client. The key itself is
 * read once here and lives only in the closure `createDokployClient` builds; it never reaches
 * `runtimeConfig` (`src/config.ts`) or any log line — see `apps/deploy/AGENTS.md`.
 */
export function loadDokployApiKey(env: DeployDokployEnv = process.env): string {
  const value = env.DOKPLOY_API_KEY;

  if (value === undefined || value.trim().length === 0) {
    throw new Error("DOKPLOY_API_KEY must be set.");
  }

  return value.trim();
}

/**
 * The only three `compose.update` settings this service can write. Closed on purpose: `env` has no
 * field here to hold it, so a caller cannot express an env write even by accident — the type itself
 * is the guarantee, the primary structural one this whole apply path rests on.
 */
export interface DokployComposeSettingsUpdate {
  composePath?: string;
  branch?: string;
  autoDeploy?: boolean;
}

export interface DokployClient {
  getDokployVersion: () => Promise<DokployVersion>;
  getContainers: () => Promise<DokployContainer[]>;
  getProjects: () => Promise<DokployProject[]>;
  getCompose: (composeId: string) => Promise<DokployCompose>;
  updateComposeSettings: (
    composeId: string,
    settings: DokployComposeSettingsUpdate,
  ) => Promise<void>;
}

/**
 * Dokploy is tRPC-derived: every call is `GET|POST /api/<router>.<procedure>`, never a REST
 * resource path. `/api/openapi.json` 404s on the running v0.29.13, so there is no spec to generate
 * a client from — this hand-writes the procedures whose response has actually been observed. See
 * `apps/deploy/AGENTS.md` before adding another. Every read goes through `callProcedure`, which
 * hardcodes `GET` and must stay that way; the one mutation this service performs,
 * `compose.update`, goes through the separate `callMutation` below instead.
 */
export function createDokployClient(options: CreateDokployClientOptions): DokployClient {
  const { callProcedure, callMutation } = createDokployTransport(options);

  return {
    getDokployVersion: () => callProcedure("settings.getDokployVersion", dokployVersionSchema),
    getContainers: () => callProcedure("docker.getContainers", dokployContainersSchema),
    getProjects: () => callProcedure("project.all", dokployProjectsSchema),
    getCompose: (composeId) => callProcedure("compose.one", dokployComposeSchema, { composeId }),
    // Named fields, never a spread: TypeScript's excess-property check only fires on an object
    // literal, so a wider `settings` object — one carrying a stray `env`, say — would otherwise
    // ride the spread onto the wire with no compile-time or runtime check catching it.
    updateComposeSettings: (composeId, settings) =>
      callMutation("compose.update", {
        composeId,
        composePath: settings.composePath,
        branch: settings.branch,
        autoDeploy: settings.autoDeploy,
      }),
  };
}
