import { mergeConfig } from "vite";
import { defineConfig } from "vitest/config";

import { createWebViteConfig } from "./vite.config";

export default mergeConfig(
  createWebViteConfig("test"),
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["./test/setup.ts"],
    },
  }),
);
