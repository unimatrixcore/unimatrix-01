import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: createCoverageConfig({
      // Keep PublicMarkdown in this report: its sanitization is also exercised by
      // the web consumer tests, and excluding it would hide security-relevant code.
      thresholds: { statements: 76, functions: 72 },
      exclude: ["src/components/ui/**"],
    }),
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
