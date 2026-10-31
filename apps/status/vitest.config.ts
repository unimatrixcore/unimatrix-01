import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
      {
        find: /^@unimatrix\/app-config$/,
        replacement: fileURLToPath(
          new URL("../../packages/app-config/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/api-client$/,
        replacement: fileURLToPath(
          new URL("../../packages/api-client/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/shared$/,
        replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/chrome\/tool$/,
        replacement: fileURLToPath(new URL("../../packages/chrome/src/tool.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/ui\/scroll-area$/,
        replacement: fileURLToPath(
          new URL("../../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/ui\/public$/,
        replacement: fileURLToPath(new URL("../../packages/ui/src/public.ts", import.meta.url)),
      },
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      },
    ],
    dedupe: ["@tanstack/react-router", "react", "react-dom"],
  },
  test: {
    coverage: createCoverageConfig({ thresholds: { statements: 77, functions: 91 } }),
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
