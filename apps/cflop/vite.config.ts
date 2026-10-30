import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type UserConfig } from "vite";

export interface CreateCflopViteConfigOptions {
  /**
   * Build for the prerender driver rather than the browser. The `react` alias
   * below resolves React to a filesystem path, which bundles it into the SSR
   * output while bare-imported `react-dom/server` stays external and resolves
   * its own copy. Two copies of React kill the render with an `Invalid hook
   * call` naming whichever component happens to render first.
   */
  ssr?: boolean;
}

export function createCflopViteConfig({
  ssr = false,
}: CreateCflopViteConfigOptions = {}): UserConfig {
  return {
    plugins: [
      tanstackRouter({
        generatedRouteTree: "./src/routes/routeTree.gen.ts",
        routeFileIgnorePattern: "routeTree\\.gen\\.(ts|js)$",
        routesDirectory: "./src/routes",
        target: "react",
      }),
      react(),
      tailwindcss(),
    ],
    // No proxy and no env: this app has no backend. The only reason it configures
    // a server at all is the port. Vite defaults to 5173, which `apps/web` also
    // wants, and the loser of that race silently moves to 5174 — so which app
    // answers on which port depended on start order. `strictPort` makes a
    // collision refuse to start rather than move.
    server: {
      port: 5174,
      strictPort: true,
    },
    preview: {
      port: 4174,
      strictPort: true,
    },
    resolve: {
      alias: [
        {
          find: /^@unimatrix\/ui\/scroll-area$/,
          replacement: fileURLToPath(
            new URL("../../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
          ),
        },
        {
          find: "@",
          replacement: fileURLToPath(new URL("./src", import.meta.url)),
        },
        {
          find: /^@unimatrix\/chrome\/tool$/,
          replacement: fileURLToPath(new URL("../../packages/chrome/src/tool.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/ui\/public$/,
          replacement: fileURLToPath(new URL("../../packages/ui/src/public.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/ui$/,
          replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/cube\/react$/,
          replacement: fileURLToPath(new URL("../../packages/cube/src/react.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/cube$/,
          replacement: fileURLToPath(new URL("../../packages/cube/src/index.ts", import.meta.url)),
        },
        ...(ssr
          ? []
          : [
              {
                find: /^react$/,
                replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
              },
            ]),
      ],
      // `@tanstack/react-router` is deduped, not just React. `@unimatrix/chrome`
      // declares it as a peer and resolves from its own directory, so without
      // this the bundle can carry two copies and the shell's `useRouterState`
      // reads a router context the app's `RouterProvider` never wrote to.
      dedupe: ["@tanstack/react-router", "react", "react-dom"],
    },
  };
}

export default defineConfig(({ isSsrBuild }) =>
  createCflopViteConfig({ ssr: isSsrBuild === true }),
);
