import react from "@vitejs/plugin-react";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";
import { assistantAliases } from "./vite.config.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: assistantAliases, dedupe: ["@tanstack/react-router", "react", "react-dom"] },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    coverage: createCoverageConfig({
      thresholds: { statements: 76, functions: 69 },
      exclude: ["src/main.tsx"],
    }),
  },
});
