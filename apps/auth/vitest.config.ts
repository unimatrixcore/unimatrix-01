import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
      {
        find: /^@unimatrix\/api-client$/,
        replacement: fileURLToPath(
          new URL("../../packages/api-client/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/auth\/react$/,
        replacement: fileURLToPath(
          new URL("../../packages/auth/src/react.tsx", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/auth$/,
        replacement: fileURLToPath(
          new URL("../../packages/auth/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/shared$/,
        replacement: fileURLToPath(
          new URL("../../packages/shared/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^@unimatrix\/ui$/,
        replacement: fileURLToPath(
          new URL("../../packages/ui/src/index.ts", import.meta.url),
        ),
      },
      {
        find: /^react$/,
        replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
  },
});
