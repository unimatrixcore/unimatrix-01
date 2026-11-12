import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: createCoverageConfig({
      thresholds: { functions: 100, statements: 100 },
    }),
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
