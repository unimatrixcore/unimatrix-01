import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, loadEnv } from "vite";

import { loadWebDevProxyConfig } from "./src/lib/config";

const webRootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
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
    server: {
      proxy: {
        "/api": {
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
          target: devProxyConfig.apiProxyTarget,
        },
      },
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
          find: /^@unimatrix\/ui$/,
          replacement: fileURLToPath(
            new URL("../../packages/ui/src/index.ts", import.meta.url),
          ),
        },
        {
          find: /^react$/,
          replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
        },
      ],
      dedupe: ["react", "react-dom"],
    },
  };
});
