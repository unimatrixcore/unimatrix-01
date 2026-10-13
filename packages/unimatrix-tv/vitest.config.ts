import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: createCoverageConfig({
      thresholds: { statements: 80, functions: 80 },
      exclude: ["src/jellyfin-adapter.ts", "src/index.ts"],
    }),
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
