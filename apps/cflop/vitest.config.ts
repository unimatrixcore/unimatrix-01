import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { createCoverageConfig } from "@unimatrix/config-vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@unimatrix\/ui\/scroll-area$/,
        replacement: fileURLToPath(
          new URL("../../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
        ),
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      {
        find: /^@unimatrix\/ui$/,
        replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/cube\/react$/,
        replacement: fileURLToPath(new URL("../../packages/cube/src/react.ts", import.meta.url)),
      },
      {
        find: /^@unimatrix\/cube$/,
        replacement: fileURLToPath(new URL("../../packages/cube/src/index.ts", import.meta.url)),
      },
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    coverage: createCoverageConfig({
      // The floors sit this far below 100 because the non-lazy route files'
      // `head: () => ({ meta: [...] })` bodies only run when the router renders
      // a route, which the Playwright smoke suite does and this suite does not.
      // Those statements are real and shipped, just unreachable from here.
      thresholds: { statements: 62, functions: 52 },
    }),
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
