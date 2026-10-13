import { createPackageConfig } from "@unimatrix/config-eslint";

export default [
  ...createPackageConfig({
    tsconfigRootDir: import.meta.dirname,
  }),
  {
    ignores: ["dist/**", "requests/**"],
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
];


