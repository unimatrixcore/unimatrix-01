import path from "node:path";

/**
 * Per-workspace import bans from the Boundaries section of `AGENTS.md`.
 *
 * This layer exists alongside `boundaries/dependencies` because the two fail in
 * different directions. `boundaries` reasons about *resolved* modules, so an
 * import it cannot resolve is classified as external and skipped — which is
 * exactly what an undeclared, newly-added forbidden dependency looks like
 * before its tsconfig path exists. `no-restricted-imports` matches the
 * specifier string itself and therefore fires whether or not the module
 * resolves.
 *
 * Every entry below is satisfied by the repo as it stands, so these are
 * ratchets against new violations rather than a list of known failures.
 *
 * `files` is deliberately not uniform. A *dependency* ban applies everywhere,
 * because importing the package from a test still means adding it to
 * `package.json`. A *purity* ban ("must stay filesystem-free") applies to
 * `src/**` only, because it is a statement about what the package ships — the
 * repo's own convention tests read source files off disk to enforce
 * conventions, and banning `node:fs` in those would be enforcing the rule
 * against the thing enforcing the rule.
 */
const SHIPPED_SOURCE = ["src/**/*.{ts,tsx,mts,cts}"];
const ALL_SOURCE = ["**/*.{ts,tsx,mts,cts}"];

const WORKSPACE_RESTRICTIONS = {
  "apps/cflop": {
    files: ALL_SOURCE,
    patterns: [
      {
        group: [
          "@unimatrix/api-client",
          "@unimatrix/api-client/*",
          "@unimatrix/shared",
          "@unimatrix/shared/*",
          "@unimatrix/content",
          "@unimatrix/content/*",
          "@tanstack/react-query",
          "@tanstack/react-query/*",
        ],
        message:
          "cflop is intentionally backend-free: no api-client, shared contracts, content loading, or react-query. Adding one of these means adding a real server-backed feature — update AGENTS.md and this rule together if that is the intent.",
      },
    ],
  },
  "apps/auth": {
    files: ALL_SOURCE,
    patterns: [
      {
        group: ["@clerk/clerk-react", "@clerk/clerk-react/*"],
        message:
          "Consume Clerk only through `@unimatrix/auth/react`, never `@clerk/clerk-react` directly, so the provider and hooks stay swappable in one place.",
      },
    ],
  },
  // Same rule as `apps/auth`, and it needs its own entry: `boundaries` reasons
  // about workspace elements, and `@clerk/clerk-react` is an external package
  // it classifies as outside the graph entirely. This is the only layer that
  // stops a direct import.
  "apps/admin": {
    files: ALL_SOURCE,
    patterns: [
      {
        group: ["@clerk/clerk-react", "@clerk/clerk-react/*"],
        message:
          "Consume Clerk only through `@unimatrix/auth/react`, never `@clerk/clerk-react` directly, so the provider and hooks stay swappable in one place.",
      },
    ],
  },
  "apps/web": {
    files: ALL_SOURCE,
    patterns: [
      {
        // A regex rather than a `group` with negations: gitignore-style
        // negation inside `group` did not exclude `@unimatrix/ui/public` here —
        // every existing, legitimate import was reported — so the allowed
        // entry points are expressed as explicit lookaheads instead.
        regex: String.raw`^@unimatrix/ui$|^@unimatrix/ui/(?!public$)(?!styles\.css$)`,
        message:
          "The public site consumes `@unimatrix/ui/public` (plus `@unimatrix/ui/styles.css`). Reaching into the wider `@unimatrix/ui` surface widens the public entry point by accident.",
      },
    ],
  },
  "packages/shared": {
    files: SHIPPED_SOURCE,
    patterns: [
      {
        group: ["react", "react-dom", "react/*", "react-dom/*", "node:*"],
        message:
          "`@unimatrix/shared` is framework-agnostic contract code: no UI, no transport, no filesystem. Keep it importable from a browser, a server, and a test alike.",
      },
    ],
  },
  "packages/api-client": {
    files: SHIPPED_SOURCE,
    patterns: [
      {
        group: ["node:*", "@clerk/*"],
        message:
          "`@unimatrix/api-client` stays DOM- and Node-lib-free and auth-library-agnostic — the consumer supplies `getAuthToken`.",
      },
    ],
  },
  // `boundaries.mjs` grants apps/deploy the `secrets` package edge workspace-wide, because it has no
  // per-directory granularity — this is the layer that narrows it back to src/secret-env/, which
  // holds the only read capability this service has against the store. src/reconcile/ carries no
  // write capability of its own and must never gain one by importing this module tree.
  "apps/deploy": {
    files: ["src/reconcile/**/*.{ts,mts,cts}"],
    patterns: [
      {
        // `group` is matched gitignore-style, not glob-style, so `*` stops at a `/` and a pattern
        // anchored to one `../` only covers a file sitting directly in src/reconcile/. The `**`
        // forms are what keep the ban true for a nested src/reconcile/<dir>/file.ts, which would
        // otherwise reach the module tree as `../../secret-env/status.js` and match nothing here.
        group: [
          "@unimatrix/secrets",
          "@unimatrix/secrets/**",
          "**/secret-env",
          "**/secret-env/**",
          "**/dokploy/transport.*",
          "**/dokploy/env-client.*",
          "**/dokploy/env-line.*",
        ],
        message:
          "src/reconcile/ never imports the secrets store — apps/deploy/AGENTS.md's no-write rule. src/secret-env/ imports from src/reconcile/, never the other way.",
      },
    ],
  },
};

/**
 * `packages/auth` ships three deliberately separate entry points: `.` stays
 * framework-agnostic and dependency-free, `./server` is Node-only, and
 * `./react` is browser-only. A cross-import between the last two would drag
 * Node built-ins into a browser bundle (or React into a Fastify plugin), which
 * is the kind of failure that surfaces at runtime in one environment only.
 *
 * Scoped by file rather than by workspace, so it lives outside the table above.
 */
const AUTH_ENTRY_POINT_CONFIGS = [
  {
    files: ["src/index.ts"],
    restrictions: [
      {
        group: ["./server", "./server.js", "./react", "./react.js", "./react.tsx"],
        message:
          "The `.` entry point of `@unimatrix/auth` must stay framework-agnostic: it may not pull in the Node-only server entry or the browser-only react entry.",
      },
    ],
  },
  {
    files: ["src/server.ts"],
    restrictions: [
      {
        group: ["./react", "./react.js", "./react.tsx", "react", "react-dom"],
        message:
          "`@unimatrix/auth/server` is Node-only. Importing the react entry (or React itself) here would put browser code in a Fastify plugin.",
      },
    ],
  },
  {
    files: ["src/react.tsx"],
    restrictions: [
      {
        group: ["./server", "./server.js", "node:*"],
        message:
          "`@unimatrix/auth/react` is browser-only. Importing the server entry (or a Node built-in) here would break the browser bundle.",
      },
    ],
  },
];

/**
 * `packages/secrets` ships two entry points: `.` (crypto, no I/O) and
 * `./client` (the secrets-service HTTP client, which depends on
 * `@unimatrix/shared`). Mirrors {@link AUTH_ENTRY_POINT_CONFIGS} — the crypto
 * entry must stay dependency-free of the client, and the client must stay
 * out of the crypto internals it has no business reaching around
 * `secret-value.ts`, which both entry points legitimately share.
 *
 * Scoped by file rather than by workspace, so it lives outside the table above.
 */
const SECRETS_ENTRY_POINT_CONFIGS = [
  {
    files: [
      "src/index.ts",
      "src/envelope.ts",
      "src/keyring.ts",
      "src/errors.ts",
      "src/secret-value.ts",
    ],
    restrictions: [
      {
        group: ["./client", "./client.js"],
        message:
          "The `.` entry point of `@unimatrix/secrets` must stay crypto-only and I/O-free: it may not pull in the HTTP client.",
      },
      {
        // Banning `./client` alone would not keep the promise: the `.` entry is
        // dependency-free only while nothing under it reaches the dependency
        // `./client` introduced. `src/client.ts` is the one file permitted to
        // import it.
        group: ["@unimatrix/shared", "@unimatrix/shared/*"],
        message:
          "The `.` entry point of `@unimatrix/secrets` has no runtime dependencies. Contract and schema imports belong in `src/client.ts`, the only file in this package that may reach `@unimatrix/shared`.",
      },
    ],
  },
  {
    files: ["src/client.ts"],
    restrictions: [
      {
        group: ["./envelope", "./envelope.js", "./keyring", "./keyring.js"],
        message:
          "`@unimatrix/secrets/client` talks to the secrets service over HTTP; it has no business reaching into the crypto internals. `./secret-value.js` (the plaintext wrapper) is the one crossing it needs.",
      },
    ],
  },
];

/**
 * `packages/cube`'s `.` entry point promises to carry no dependency at all —
 * every consumer of `.`, including the `gen:algs` SSR bundle, takes that on
 * faith. `ignores` excludes the two files that legitimately need React: the
 * `./react` entry point and the view components it re-exports.
 *
 * Banning `react` and `@unimatrix/ui` alone would not keep that promise, for
 * the same reason `packages/secrets` bans `./client` and everything under it:
 * the `.` entry stays dependency-free only while nothing under it reaches the
 * files that legitimately hold the dependency. So `./components` is banned
 * beside `./react` — a convenience re-export of a view from `src/index.ts`
 * would otherwise pull React into every consumer with lint, typecheck and
 * tests all green.
 *
 * Scoped by file rather than by workspace, so it lives outside the table above.
 */
const CUBE_ENTRY_POINT_CONFIGS = [
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/react.ts", "src/components/**"],
    restrictions: [
      {
        group: [
          "react",
          "react-dom",
          "@unimatrix/ui",
          "@unimatrix/ui/*",
          "./react",
          "./react.js",
          "./components",
          "./components/*",
          "./components/**",
        ],
        message:
          "The `.` entry point of `@unimatrix/cube` carries no dependency at all — a React or `@unimatrix/ui` import here reaches every consumer of `.`, including the gen:algs SSR bundle. Put React-touching code behind `./react` instead.",
      },
    ],
  },
];

function workspaceIdOf(tsconfigRootDir) {
  const group = path.basename(path.dirname(tsconfigRootDir));
  return `${group}/${path.basename(tsconfigRootDir)}`;
}

/**
 * Returns the flat-config entries enforcing this workspace's import bans, or an
 * empty array when the workspace has none. `files` patterns in a returned entry
 * are relative to the directory ESLint runs in, which under `turbo run lint` is
 * the workspace directory itself.
 */
export function createRestrictedImportConfigs({ tsconfigRootDir }) {
  const workspaceId = workspaceIdOf(tsconfigRootDir);
  const configs = [];

  const restrictions = WORKSPACE_RESTRICTIONS[workspaceId];
  if (restrictions) {
    configs.push({
      files: restrictions.files,
      rules: {
        "@typescript-eslint/no-restricted-imports": ["error", { patterns: restrictions.patterns }],
      },
    });
  }

  if (workspaceId === "packages/auth") {
    for (const entry of AUTH_ENTRY_POINT_CONFIGS) {
      configs.push({
        files: entry.files,
        rules: {
          "@typescript-eslint/no-restricted-imports": ["error", { patterns: entry.restrictions }],
        },
      });
    }
  }

  if (workspaceId === "packages/secrets") {
    for (const entry of SECRETS_ENTRY_POINT_CONFIGS) {
      configs.push({
        files: entry.files,
        rules: {
          "@typescript-eslint/no-restricted-imports": ["error", { patterns: entry.restrictions }],
        },
      });
    }
  }

  if (workspaceId === "packages/cube") {
    for (const entry of CUBE_ENTRY_POINT_CONFIGS) {
      configs.push({
        files: entry.files,
        ...(entry.ignores ? { ignores: entry.ignores } : {}),
        rules: {
          "@typescript-eslint/no-restricted-imports": ["error", { patterns: entry.restrictions }],
        },
      });
    }
  }

  return configs;
}
