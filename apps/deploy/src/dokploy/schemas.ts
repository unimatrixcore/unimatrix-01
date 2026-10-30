import { parseEnvLine } from "./env-line.js";
import { z } from "zod";

/**
 * `settings.getDokployVersion` answers with a bare JSON string, not an object — measured
 * `"v0.29.13"` against the running instance on 2026-08-14. A wrapper object is the shape to expect
 * and the wrong one.
 */
export const dokployVersionSchema = z.string();

/**
 * Field-for-field as measured on 2026-08-14; every value arrives as a string, `ports` and `status`
 * included. `z.object`, not `z.strictObject`: Dokploy is upstream software this repo does not
 * control, and a new field appearing in a later release must not turn every call into a validation
 * error.
 */
export const dokployContainerSchema = z.object({
  containerId: z.string(),
  name: z.string(),
  image: z.string(),
  ports: z.string(),
  state: z.string(),
  status: z.string(),
});

export const dokployContainersSchema = z.array(dokployContainerSchema);

/**
 * `project.all` measured 2026-08-20: an array of projects, each carrying (among other fields)
 * `createdAt, description, env, environments, name, organizationId, projectId, projectTags`. The
 * top-level `env` is a real leak risk — Dokploy answers with every project's whole
 * environment-variable blob there — so it is never declared below. `z.object` strips a key it does
 * not name rather than passing it through, which is what defeats that leak: the parsed value
 * simply cannot carry it, independent of any handler remembering not to read it.
 *
 * Each `environments[]` entry carried `applications, compose, environmentId, isDefault, libsql,
 * mariadb, mongo, mysql, name, postgres, redis`; only the fields the reconcile diff needs are
 * declared. Each `compose[]` entry was exactly `composeId, composeStatus, name`.
 */
export const dokployComposeSummarySchema = z.object({
  composeId: z.string(),
  composeStatus: z.string(),
  name: z.string(),
});

export const dokployEnvironmentSchema = z.object({
  environmentId: z.string(),
  name: z.string(),
  compose: z.array(dokployComposeSummarySchema),
});

export const dokployProjectSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  environments: z.array(dokployEnvironmentSchema),
});

export const dokployProjectsSchema = z.array(dokployProjectSchema);

/** One `env` line's key and whether its value is blank — never the value itself. */
export interface DokployComposeEnvKeyState {
  readonly key: string;
  readonly blank: boolean;
}

/**
 * Reduces Dokploy's plaintext `env` blob to key presence and blankness. Runs only inside
 * {@link dokployComposeSchema}'s own `.transform()`, so the plaintext exists nowhere but this
 * function's parameter — the schema's parsed output has no field that could hold a value.
 *
 * Rules: split on `\r?\n`; trim each line; skip empty lines and `#` comment lines; skip a line with
 * no `=`; the key is everything before the first `=`, trimmed, and a line whose key trims empty is
 * skipped; `blank` is true when the remainder trims to empty; a duplicate key keeps the last
 * occurrence; the result is sorted by key.
 */
export function readEnvKeyStates(env: string | null): readonly DokployComposeEnvKeyState[] {
  if (env === null) return [];

  const states = new Map<string, boolean>();

  for (const line of env.split(/\r?\n/u)) {
    const entry = parseEnvLine(line);
    if (entry !== null) states.set(entry.key, entry.value.length === 0);
  }

  return [...states.entries()]
    .map(([key, blank]) => ({ key, blank }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * `compose.one?composeId=<id>` measured 2026-08-20 against the running `api` service: 57 keys in
 * total, including `appName, autoDeploy, branch, command, composeFile, composeId, composePath,
 * composeStatus, composeType, createdAt, description, domains, env, environment, environmentId,
 * github, githubId, mounts, name, owner, repository, server, serverId, sourceType, suffix,
 * triggerType, watchPaths`. Only the fields `src/reconcile/diff.ts` and `src/reconcile/apply.ts`
 * compare are declared here; the rest — `domains` and `watchPaths` included, both deliberately out
 * of scope — are stripped by `z.object`'s default behaviour, same reasoning as
 * `dokployProjectSchema`. `owner`/`repository` anchor a name-matched service to this repository
 * before `apply.ts` writes anything to it — see that file's `refused-foreign-repo` outcome.
 *
 * `env` arrives as a decrypted plaintext blob — measured, for the `api` service, holding
 * `CORS_ALLOWED_ORIGINS, CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY, CLERK_JWT_KEY, SECRETS_BASE_URL,
 * SECRETS_SERVICE_TOKEN, SECRETS_INTEGRATIONS_MANAGE_TOKEN, SECRETS_PLATFORM_WRITE_TOKEN,
 * SECRETS_TLS_CERT_BASE64, IMAGE_TAG`, all non-blank. `.transform(readEnvKeyStates)` is what turns
 * that blob into key/blank pairs before this schema's output exists anywhere else.
 */
export const dokployComposeSchema = z.object({
  composeId: z.string(),
  name: z.string(),
  environmentId: z.string(),
  composePath: z.string(),
  sourceType: z.string(),
  branch: z.string().nullable(),
  autoDeploy: z.boolean().nullable(),
  owner: z.string().nullable(),
  repository: z.string().nullable(),
  env: z.string().nullable().transform(readEnvKeyStates),
});

/**
 * A `compose.update` non-2xx body: `{code, message, data: {zodError}, issues}`. Only `code` and
 * `data.zodError.fieldErrors`' **keys** are declared — never `message` or a `fieldErrors` value,
 * both of which can echo the offending field value back (`client.ts`'s `callMutation`). `z.object`
 * everywhere here so an unrecognised field is stripped rather than rejected: this is upstream
 * software this repo does not control, and a body that fails to match degrades to the bare-status
 * fallback in `callMutation` rather than throwing inside the error path.
 */
export const dokployMutationErrorSchema = z.object({
  code: z.string().optional(),
  data: z
    .object({
      zodError: z
        .object({
          fieldErrors: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type DokployVersion = z.output<typeof dokployVersionSchema>;
export type DokployContainer = z.output<typeof dokployContainerSchema>;
export type DokployComposeSummary = z.output<typeof dokployComposeSummarySchema>;
export type DokployEnvironment = z.output<typeof dokployEnvironmentSchema>;
export type DokployProject = z.output<typeof dokployProjectSchema>;
export type DokployCompose = z.output<typeof dokployComposeSchema>;
