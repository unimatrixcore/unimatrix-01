import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const pokerAliases = [
  {
    find: /^@unimatrix\/instant-list$/,
    replacement: fileURLToPath(
      new URL("../../packages/instant-list/src/index.ts", import.meta.url),
    ),
  },
  {
    find: /^@unimatrix\/ui\/native-select$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/components/ui/native-select.tsx", import.meta.url),
    ),
  },
  {
    find: /^@unimatrix\/ui\/popover$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/components/ui/popover.tsx", import.meta.url),
    ),
  },
  {
    find: /^@unimatrix\/ui\/scroll-area$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
    ),
  },
  {
    find: /^@unimatrix\/poker\/client$/,
    replacement: fileURLToPath(new URL("../../packages/poker/src/client.ts", import.meta.url)),
  },
  {
    find: /^@unimatrix\/chrome\/tool$/,
    replacement: fileURLToPath(new URL("../../packages/chrome/src/tool.ts", import.meta.url)),
  },
  {
    find: /^@unimatrix\/ui\/public$/,
    replacement: fileURLToPath(new URL("../../packages/ui/src/public.ts", import.meta.url)),
  },
  {
    find: /^@unimatrix\/ui$/,
    replacement: fileURLToPath(new URL("../../packages/ui/src/index.ts", import.meta.url)),
  },
  {
    find: /^@unimatrix\/shared$/,
    replacement: fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  },
  {
    find: /^@unimatrix\/poker$/,
    replacement: fileURLToPath(new URL("../../packages/poker/src/index.ts", import.meta.url)),
  },
  { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react", import.meta.url)) },
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rolldownOptions: {
      input: {
        poker: fileURLToPath(new URL("./index.html", import.meta.url)),
        regions: fileURLToPath(new URL("./regions.html", import.meta.url)),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    watch: {
      ignored: [
        "**/coverage/**",
        "**/test-results/**",
        "**/.test-browser-dist/**",
        "**/.orchestration/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/playwright-report/**",
      ],
    },
  },
  preview: { host: "127.0.0.1", port: 4180, strictPort: true },
  resolve: {
    alias: pokerAliases,
    dedupe: [
      "@tanstack/react-router",
      "@tanstack/react-query",
      "@tanstack/react-virtual",
      "react",
      "react-dom",
    ],
  },
});
