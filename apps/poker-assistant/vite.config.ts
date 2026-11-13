import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export const assistantAliases = [
  {
    find: /^@unimatrix\/ui\/scroll-area$/,
    replacement: fileURLToPath(
      new URL("../../packages/ui/src/components/ui/scroll-area.tsx", import.meta.url),
    ),
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
    find: /^@unimatrix\/poker\/client$/,
    replacement: fileURLToPath(new URL("../../packages/poker/src/client.ts", import.meta.url)),
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
  server: { host: "127.0.0.1", port: 5181, strictPort: true },
  preview: { host: "127.0.0.1", port: 4181, strictPort: true },
  resolve: { alias: assistantAliases, dedupe: ["@tanstack/react-router", "react", "react-dom"] },
});
