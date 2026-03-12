import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
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
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      react: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
    },
    dedupe: ["react", "react-dom"],
  },
});
