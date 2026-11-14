import react from "@vitejs/plugin-react";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";
import { pokerAliases } from "./vite.config.js";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: pokerAliases, dedupe: ["@tanstack/react-router", "react", "react-dom"] },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    coverage: createCoverageConfig({ thresholds: { statements: 50, functions: 54 } }),
  },
});
