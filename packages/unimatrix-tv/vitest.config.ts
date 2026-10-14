import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

const coverage = createCoverageConfig({
  thresholds: { statements: 86, functions: 86 },
  exclude: ["src/index.ts", "src/bootstrap.ts"],
});

export default defineConfig({
  test: {
    coverage: {
      ...coverage,
      thresholds: {
        ...coverage.thresholds,
        "src/loading-gate.ts": { statements: 88, functions: 87 },
        "src/jellyfin-adapter.ts": { statements: 85, functions: 86 },
      },
    },
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
