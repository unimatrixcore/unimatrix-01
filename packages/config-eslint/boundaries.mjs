import path from "node:path";

import boundaries from "eslint-plugin-boundaries";

/**
 * The cross-workspace import graph from the Boundaries section of `AGENTS.md`,
 * expressed as data so lint enforces it instead of prose asking an agent to.
 *
 * Key: workspace directory. Value: the `packages/*` directories it may import
 * from. A workspace may always import from itself. Anything not listed is
 * denied — the rule runs `default: "disallow"`.
 *
 * Entries are the *current* truth, not an aspiration: every edge here is one
 * that source in this repo actually uses today, so the rule is a ratchet
 * against new coupling rather than a backlog of pre-existing failures.
 */
const ALLOWED_PACKAGE_IMPORTS = {
  // `e2e-helpers` is granted only to the two workspaces that actually run a
  // Playwright suite, rather than to everyone via SHARED_CONFIG_PACKAGES below.
  // It ships assertion code, not configuration, so a workspace importing it is
  // a fact worth stating per workspace. Note the grant is workspace-wide — the
  // rule has no per-directory granularity — so it does not by itself stop `src/`
  // from importing test helpers; nothing in the app builds does today.
  // `shared` was added when blog and project content moved behind the API:
  // route loaders and the admin UI work in terms of the content contracts'
  // request/response types, and those live in `@unimatrix/shared` by rule
  // ("shared request/response shapes belong in @unimatrix/shared"). The vite
  // alias and tsconfig path for it predate this entry.
  // `deploy-config` is granted to every app below for the same reason: each
  // app's own `deploy.config.ts` imports the archetype builders. It is a
  // devDependency, never shipped, so it is listed once here rather than
  // folded into `SHARED_CONFIG_PACKAGES` — that set is for build tooling with
  // no runtime shape of its own, and this package's exported types are a real
  // (if deploy-time-only) contract each app opts into explicitly.
  "apps/web": [
    "api-client",
    "app-config",
    "auth",
    "chrome",
    "content",
    "deploy-config",
    "e2e-helpers",
    "shared",
    "ui",
  ],
  "apps/api": ["auth", "db", "deploy-client", "deploy-config", "secrets", "shared"],
  // Never `db`: this service's SQLite file lives on its own volume, not
  // packages/db's (single-writer, already owned by the API container) — see
  // apps/secrets/AGENTS.md.
  "apps/secrets": ["deploy-config", "secrets", "shared"],
  // `secrets` is `./client` only — `src/secret-env/` resolves a declared name's
  // value read-only, on the `secrets-status` CLI path. This service still holds
  // no write capability against the store; see apps/deploy/AGENTS.md.
  "apps/deploy": ["deploy-config", "secrets", "shared"],
  // Deliberately narrow. AGENTS.md: cflop must not gain
  // `@unimatrix/api-client`, `@unimatrix/shared`, or `@unimatrix/content`
  // unless a real server-backed feature is added. Neither `chrome` nor `cube`
  // widens that: chrome carries no auth, transport, or content dependency of
  // its own, which is the whole reason its shells take the account control as
  // a slot, and cube is the move engine and diagram geometry — no transport,
  // no content, and its own `.` entry carries no dependency at all.
  "apps/cflop": ["chrome", "cube", "deploy-config", "e2e-helpers", "ui"],
  "apps/status": ["api-client", "app-config", "chrome", "deploy-config", "shared", "ui"],
  "apps/auth": ["app-config", "auth", "chrome", "deploy-config", "ui"],
  // `api-client` and `shared` were added when the CMS moved onto this origin:
  // the content section calls the API through `@unimatrix/api-client` and
  // shares its request/response types with `apps/web`'s public content
  // routes through `@unimatrix/shared`.
  "apps/admin": ["api-client", "app-config", "auth", "chrome", "deploy-config", "shared", "ui"],
  "packages/api-client": ["shared"],
  "packages/deploy-client": ["shared"],
  // Env validation for the Vite apps' config boundaries. A leaf on purpose:
  // `zod` is its only dependency and stays its implementation detail — apps
  // compose schemas through `envSchema` instead of importing zod themselves.
  "packages/app-config": [],
  // The Dockerfile/compose generator's config types and archetype builders.
  // A leaf with zero runtime dependencies, same reasoning as `e2e-helpers`
  // below: `default` is "disallow", so a workspace with no policy of its own
  // cannot even resolve its own relative imports.
  "packages/deploy-config": [],
  // The shared chrome composes `ui` primitives and nothing else. It must never
  // gain `auth`: both of its shells take the account control as a `ReactNode`
  // slot precisely so a sign-in-free tool can import one without pulling Clerk
  // into its dependency tree.
  "packages/chrome": ["ui"],
  // Mirrors chrome: composes ui and nothing else. The finer-grained rule —
  // only `./react` may actually import it — is `restricted-imports.mjs`'s
  // job, not this one's.
  "packages/cube": ["ui"],
  "packages/user-data": ["api-client", "auth", "shared"],
  // Its `.` entry is a leaf, but `./client` (the secrets-service HTTP client)
  // consumes `getSecretValueContract`/`getSecretQuerySchema` from `shared` —
  // the rule has no per-entry-point granularity, so the grant is
  // workspace-wide even though `.` itself imports nothing from it.
  "packages/secrets": ["shared"],
  // Leaves. `packages/shared` in particular must stay free of transport, UI,
  // and content-loading code, which starts with importing none of it.
  "packages/ui": [],
  "packages/shared": [],
  "packages/content": [],
  "packages/db": [],
  "packages/auth": [],
  "packages/unimatrix-tv": [],
  // A leaf, and listed even though it imports no sibling package: `default` is
  // "disallow", so a workspace with no policy of its own cannot even resolve its
  // own relative imports.
  "packages/e2e-helpers": [],
};

/**
 * Build-tooling packages every workspace may import. They carry no runtime code
 * — they are consumed by `eslint.config.mjs`, `tsconfig.json`, and
 * `vitest.config.ts` — so an edge to one says nothing about the runtime
 * coupling this rule exists to constrain.
 */
const SHARED_CONFIG_PACKAGES = ["config-eslint", "config-typescript", "config-vitest"];

function toElement(workspace) {
  const [group, name] = workspace.split("/");
  return { type: group === "apps" ? "app" : "pkg", name };
}

function buildPolicies() {
  return Object.entries(ALLOWED_PACKAGE_IMPORTS).map(([workspace, allowed]) => {
    const from = toElement(workspace);

    return {
      from: { element: { type: from.type, captured: { name: from.name } } },
      allow: [
        // A workspace's own relative imports are same-element and must stay legal.
        { to: { element: { type: from.type, captured: { name: from.name } } } },
        ...[...allowed, ...SHARED_CONFIG_PACKAGES].map((name) => ({
          to: { element: { type: "pkg", captured: { name } } },
        })),
      ],
    };
  });
}

/**
 * `boundaries` matches element patterns against paths relative to
 * `boundaries/root-path`. Turbo runs `eslint .` with the cwd set to the
 * workspace directory, so without this the `apps/*` and `packages/*` patterns
 * match nothing, every file is classified as belonging to no element, and the
 * rule silently enforces nothing while CI stays green.
 *
 * Verified rather than assumed: with the setting removed, a deliberate
 * cross-package violation reports "File does not match any file pattern and
 * does not belong to any known element" instead of a policy error.
 */
export function createBoundariesConfig({ tsconfigRootDir }) {
  const repoRoot = path.resolve(tsconfigRootDir, "..", "..");

  return {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: { boundaries },
    settings: {
      "boundaries/root-path": repoRoot,
      // Without a resolver, flat config leaves every bare specifier unresolved,
      // and `boundaries` classifies unresolved imports as *external* — which the
      // `dependencies` rule skips. Since every cross-workspace import in this
      // repo is a package specifier (`@unimatrix/ui/public`) rather than a
      // relative path, omitting this makes the whole rule a no-op. The
      // TypeScript resolver is the right one here because each workspace's
      // tsconfig already maps `@unimatrix/*` onto package sources.
      "import/resolver": {
        typescript: { project: path.join(tsconfigRootDir, "tsconfig.json") },
      },
      "boundaries/elements": [
        { type: "app", pattern: "apps/*", capture: ["name"] },
        { type: "pkg", pattern: "packages/*", capture: ["name"] },
      ],
    },
    rules: {
      "boundaries/dependencies": ["error", { default: "disallow", policies: buildPolicies() }],
    },
  };
}
