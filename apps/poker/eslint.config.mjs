import { createAppConfig } from "@unimatrix/config-eslint";
export default [
  { ignores: ["src-tauri/**", "public/static/js/**", "test/upstream/**", ".test-browser-dist/**"] },
  ...createAppConfig({ tsconfigRootDir: import.meta.dirname }),
];
