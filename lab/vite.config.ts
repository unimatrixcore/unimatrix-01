import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

/**
 * The UX prototyping harness. Local-dev only: there is no `build` script, no
 * Dockerfile, no compose file, and no CI image job, so this config is only ever
 * read by `vite` in dev mode. A `preview` block would be dead configuration
 * describing a build that never happens.
 *
 * No `tanstackRouter` plugin, unlike the three apps. The router here is written
 * by hand (`src/app/router.tsx`) and prototypes are discovered with
 * `import.meta.glob` instead of file-based codegen, because a generated route
 * tree would churn on every prototype added or deleted — in a directory whose
 * entire point is to stay empty on `main`.
 */
export function createLabViteConfig(): UserConfig {
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // `host` is deliberately left at Vite's default (localhost only). This
      // harness renders unreviewed prototype code against mock data; nothing
      // about it is meant to be reachable from another machine.
      port: 5180,
    },
    resolve: {
      alias: [
        {
          find: /^@unimatrix\/ui\/scroll-area$/,
          replacement: fileURLToPath(
            new URL("../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
          ),
        },
        {
          find: "@",
          replacement: fileURLToPath(new URL("./src", import.meta.url)),
        },
        // The `.` entry of `@unimatrix/auth` only — the permission scheme,
        // which is framework-agnostic and dependency-free. `./react` (browser
        // Clerk) and `./server` (a Fastify plugin) get no mapping here and are
        // banned by name in `eslint.config.mjs`.
        {
          find: /^@unimatrix\/auth$/,
          replacement: fileURLToPath(new URL("../packages/auth/src/index.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/chrome\/tool$/,
          replacement: fileURLToPath(new URL("../packages/chrome/src/tool.ts", import.meta.url)),
        },
        // `/react` before the bare entry, for the first-match-wins reason
        // spelled out at the `@unimatrix/ui` pair below.
        {
          find: /^@unimatrix\/cube\/react$/,
          replacement: fileURLToPath(new URL("../packages/cube/src/react.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/cube$/,
          replacement: fileURLToPath(new URL("../packages/cube/src/index.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/shared$/,
          replacement: fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url)),
        },
        // `/public` must precede the bare `@unimatrix/ui` entry: vite walks the
        // alias array in order and the first matching `find` wins.
        //
        // Both point at source rather than `dist`. `packages/ui` publishes
        // `./dist` via its `exports` map and is built with `tsc`, so resolving
        // it normally means editing a shared component shows nothing here until
        // a rebuild — which defeats the entire purpose of a design harness.
        // Every Vite app carries the same pair of aliases for the same reason;
        // this workspace exists as a prototyping harness, not because of how it
        // resolves modules.
        {
          find: /^@unimatrix\/ui\/public$/,
          replacement: fileURLToPath(new URL("../packages/ui/src/public.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/ui\/editor$/,
          replacement: fileURLToPath(new URL("../packages/ui/src/editor.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/ui$/,
          replacement: fileURLToPath(new URL("../packages/ui/src/index.ts", import.meta.url)),
        },
        {
          find: /^react$/,
          replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
        },
      ],
      // `@tanstack/react-router` is deduped, not just React. `@unimatrix/chrome`
      // declares it as a peer and resolves from its own directory, so without
      // this the bundle can carry two copies and the shell's `useRouterState`
      // reads a router context the app's `RouterProvider` never wrote to.
      dedupe: ["@tanstack/react-router", "react", "react-dom"],
    },
  };
}

export default defineConfig(() => createLabViteConfig());
