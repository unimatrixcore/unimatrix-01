import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: createCoverageConfig({
      thresholds: { statements: 82, functions: 74 },
    }),
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
