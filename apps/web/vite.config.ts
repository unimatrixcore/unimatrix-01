import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      generatedRouteTree: "./src/routes/routeTree.gen.ts",
      routeFileIgnorePattern: "routeTree\\.gen\\.(ts|js)$",
      routesDirectory: "./src/routes",
      target: "react",
    }),
    react(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
