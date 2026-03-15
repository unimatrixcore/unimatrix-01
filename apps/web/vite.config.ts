import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:3001";

export default defineConfig({
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
        target: process.env.VITE_API_TARGET ?? DEFAULT_API_PROXY_TARGET,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@unimatrix/api-client": fileURLToPath(
        new URL("../../packages/api-client/src/index.ts", import.meta.url),
      ),
      "@unimatrix/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
      "@unimatrix/ui": fileURLToPath(
        new URL("../../packages/ui/src/index.ts", import.meta.url),
      ),
      react: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
});

