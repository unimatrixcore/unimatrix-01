import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { pokerAliases } from "./vite.config.js";
export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [
    {
      name: "poker-legacy-test-styles",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith("/src/collector/main.tsx"))
          return `import '../styles.css';\nwindow.startPokerOcr ??= async () => {};\n${code}`;
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: pokerAliases, dedupe: ["@tanstack/react-router", "react", "react-dom"] },
  build: {
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: fileURLToPath(new URL("./src/collector/main.tsx", import.meta.url)),
      formats: ["iife"],
      name: "CollectorSourceUi",
      fileName: () => "collector-ui.js",
      cssFileName: "collector-ui",
    },
  },
});
