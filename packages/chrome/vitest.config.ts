import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@unimatrix\/ui\/scroll-area$/,
        replacement: fileURLToPath(
          new URL("../ui/src/components/ui/scroll-area.tsx", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/ui\/public$/,
        replacement: fileURLToPath(new URL("../ui/src/public.ts", import.meta.url)),
      },
    ],
  },
  test: {
    coverage: createCoverageConfig({
      thresholds: { statements: 97, functions: 97 },
    }),
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
