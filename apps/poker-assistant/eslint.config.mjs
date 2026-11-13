import { createAppConfig } from "@unimatrix/config-eslint";

export default [
  ...createAppConfig({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ["src-tauri/**", ".test-browser-dist/**"] },
];
