import { fileURLToPath } from "node:url";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@unimatrix\/shared$/,
        replacement: fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    coverage: createCoverageConfig({ thresholds: { statements: 100, functions: 100 } }),
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
