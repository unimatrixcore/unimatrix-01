import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, loadEnv, type UserConfig } from "vite";

import { loadWebDevProxyConfig } from "./src/lib/config";

const webRootDir = fileURLToPath(new URL(".", import.meta.url));

export function createWebViteConfig(mode: string): UserConfig {
  const env = loadEnv(mode, webRootDir, "VITE_");
  const devProxyConfig = loadWebDevProxyConfig(env);

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
    build: {
      rolldownOptions: {
        // The renderer has no top-level effects. Its public barrel re-export
        // otherwise pulls the renderer into the initial bundle even when unused.
        treeshake: {
          moduleSideEffects: (id: string) =>
            !/[\\/]packages[\\/]ui[\\/]src[\\/]components[\\/]public-markdown\.tsx$/u.test(id),
        },
        output: {
          codeSplitting: {
            // Shared runtime and class helpers must not be placed in the lazy
            // renderer chunk: the initial app needs them and would preload it.
            groups: [
              {
                name: "ui-utilities",
                test: (id: string) =>
                  /[\\/]packages[\\/]ui[\\/]src[\\/]lib[\\/]utils\.ts$/u.test(id) ||
                  /[\\/]node_modules[\\/](?:\.pnpm[\\/][^/\\]+[\\/]node_modules[\\/])?(?:clsx|tailwind-merge)[\\/]/u.test(
                    id,
                  ),
              },
              {
                name: "react-runtime",
                test: /[\\/]node_modules[\\/](?:\.pnpm[\\/][^/\\]+[\\/]node_modules[\\/])?(?:react|react-dom|scheduler)[\\/]/u,
              },
            ],
          },
        },
      },
    },
    server: {
      // Explicit and strict. Vite's default is 5173 for whichever app starts
      // first and a silent shift to the next free port for the second — so two
      // apps that both defaulted would swap identities depending on start order,
      // and `DEFAULT_API_CORS_ALLOWED_ORIGINS` only allows 5173. `strictPort`
      // turns a collision into a refusal to start instead of a wrong origin.
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": {
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          target: devProxyConfig.apiProxyTarget,
        },
      },
      watch: {
        // Vite's watcher ignores `node_modules` and `.git` and nothing else, so
        // a `vitest run` beside a running dev server rewrites the hundreds of
        // HTML files under `coverage/` and the page full-reloads once per file.
        // Measured: 63 reloads from one test run, each one cancelling whatever
        // requests were in flight — which reads as a request that hangs
        // forever rather than as a reload storm.
        ignored: ["**/coverage/**", "**/dist/**", "**/.turbo/**", "**/playwright-report/**"],
      },
    },
    // `playwright.config.ts` starts the preview server with an explicit
    // `--port 4173`, which is also what the API's CORS allowlist contains. Stating
    // it here keeps a bare `vite preview` on the same port as the smoke suite.
    preview: {
      port: 4173,
      strictPort: true,
    },
    resolve: {
      alias: [
        {
          find: "@",
          replacement: fileURLToPath(new URL("./src", import.meta.url)),
        },
        {
          find: /^@unimatrix\/api-client$/,
          replacement: fileURLToPath(
            new URL("../../packages/api-client/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^@unimatrix\/app-config$/,
          replacement: fileURLToPath(
            new URL("../../packages/app-config/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^@unimatrix\/content$/,
          replacement: fileURLToPath(
            new URL("../../packages/content/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^@unimatrix\/shared$/,
          replacement: fileURLToPath(
            new URL("../../packages/shared/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^@unimatrix\/chrome\/public$/,
          replacement: fileURLToPath(
            new URL("../../packages/chrome/src/public.ts", import.meta.url),
          ),
        },
        {
          find: /^@unimatrix\/ui\/markdown$/,
          replacement: fileURLToPath(
            new URL("../../packages/ui/src/components/public-markdown.tsx", import.meta.url),
          ),
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
          find: /^react$/,
          replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
        },
      ],
      // `@tanstack/react-router` is deduped, not just React. `@unimatrix/chrome`
      // declares it as a peer and resolves from its own directory, so without
      // this the bundle can carry two copies and the shell's `useRouterState`
      // reads a router context the app's `RouterProvider` never wrote to.
      dedupe: ["@tanstack/react-query", "@tanstack/react-router", "react", "react-dom"],
    },
  };
}

export default defineConfig(({ mode }) => createWebViteConfig(mode));
