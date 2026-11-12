import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: createCoverageConfig({ thresholds: { statements: 94, functions: 88 } }),
  },
});
