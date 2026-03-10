import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const sharedIgnores = [
  "**/dist/**",
  "**/coverage/**",
  "**/node_modules/**",
];

function createTypedConfig({ globalsMap, tsconfigRootDir }) {
  const typedFiles = ["**/*.{ts,tsx,mts,cts}"];
  const typedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typedFiles,
  }));

  return tseslint.config(
    {
      ignores: sharedIgnores,
    },
    js.configs.recommended,
    ...typedConfigs,
    {
      files: typedFiles,
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        globals: globalsMap,
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          {
            prefer: "type-imports",
          },
        ],
        "@typescript-eslint/no-confusing-void-expression": "error",
      },
    },
  );
}

export function createPackageConfig(options = {}) {
  return createTypedConfig({
    globalsMap: globals.node,
    tsconfigRootDir: options.tsconfigRootDir ?? process.cwd(),
  });
}

export function createAppConfig(options = {}) {
  return createTypedConfig({
    globalsMap: {
      ...globals.browser,
      ...globals.node,
    },
    tsconfigRootDir: options.tsconfigRootDir ?? process.cwd(),
  });
}
