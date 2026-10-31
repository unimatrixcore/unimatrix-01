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
        output: {
          // Rolldown emits a separate chunk for every module shared by two or
          // more chunks. Note the top-level `minSize`/`minShareCount` keys are
          // only fallbacks for `groups` entries — setting them alone does
          // nothing, which is worth knowing before reaching for them.
          codeSplitting: {
            groups: [
              {
                name: "app",
                // Workspace source only. Third-party chunking is left at the
                // default: a single vendor group also swallows dependencies
                // that only lazy routes need, which grew the eager set from
                // 954 kB to 992 kB and gave back most of what the smaller
                // request count won.
                test: (id: string) => {
                  if (/[\\/]node_modules[\\/]/u.test(id)) return false;

                  return /[\\/](apps[\\/]web|packages[\\/][a-z-]+)[\\/]src[\\/]/u.test(id);
                },
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
      dedupe: ["@tanstack/react-router", "react", "react-dom"],
    },
  };
}

export default defineConfig(({ mode }) => createWebViteConfig(mode));
