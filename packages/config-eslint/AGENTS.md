# AGENTS.md

## 1. Overview
`packages/config-eslint` is the shared ESLint flat-config workspace for the monorepo. It centralizes typed lint behavior so apps and packages can stay thin and consistent.

## 2. Folder Structure
- `index.mjs`: shared config factories and common ignore rules.
- `package.json`: package export and peer dependency contract for downstream workspaces.

## 3. Core Behaviors & Patterns
- **Factory-based configs**: Downstream workspaces import `createPackageConfig(...)` or `createAppConfig(...)` and pass `tsconfigRootDir`. Keep workspace lint files as thin wrappers around those factories.
- **Typed lint baseline**: The factory builds on `typescript-eslint`'s typed recommended configs, then adds shared rules such as `consistent-type-imports` and `no-confusing-void-expression`.
- **Environment split**: `createPackageConfig(...)` uses Node globals, while `createAppConfig(...)` merges browser and Node globals. Choose the factory based on the runtime surface instead of hand-editing globals in each workspace.
- **Shared ignores**: Dist, coverage, and node_modules ignores live here. Add cross-repo lint ignores in this package rather than repeating them in each consumer.

## 4. Conventions
- **Consumers**: Local `eslint.config.mjs` files should stay minimal and call the appropriate factory with `tsconfigRootDir: import.meta.dirname`.
- **Exports**: Keep the public API small and explicit; this package exports the shared factories from `index.mjs` rather than a large tree of helper modules.
- **Rule changes**: Adjust lint rules here only when the behavior should apply repo-wide, since all downstream workspaces inherit the shared factories.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/config-eslint` structure, patterns, and conventions.
