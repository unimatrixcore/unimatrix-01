import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, loadEnv, type UserConfig } from "vite";

import { loadAuthAppDevProxyConfig } from "./src/lib/config";

const authAppRootDir = fileURLToPath(new URL(".", import.meta.url));

export function createAuthAppViteConfig(mode: string): UserConfig {
  const env = loadEnv(mode, authAppRootDir, "VITE_");
  const devProxyConfig = loadAuthAppDevProxyConfig(env);

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
    server: {
      port: 5175,
      strictPort: true,
      proxy: {
        "/api": {
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          target: devProxyConfig.apiProxyTarget,
        },
      },
    },
    preview: {
      port: 4175,
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
          find: /^@unimatrix\/auth\/react$/,
          replacement: fileURLToPath(new URL("../../packages/auth/src/react.tsx", import.meta.url)),
        },
        {
          find: /^@unimatrix\/auth$/,
          replacement: fileURLToPath(new URL("../../packages/auth/src/index.ts", import.meta.url)),
        },
        {
          find: /^@unimatrix\/shared$/,
          replacement: fileURLToPath(
            new URL("../../packages/shared/src/index.ts", import.meta.url),
          ),
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

export default defineConfig(({ mode }) => createAuthAppViteConfig(mode));
