# AGENTS.md

## 1. Overview
`packages/config-typescript` provides the shared TypeScript compiler baselines for the monorepo. It exists so apps and libraries can extend a small set of strict presets instead of copying compiler options around the repo.

## 2. Folder Structure
- `base.json`: the strict shared baseline used by all TypeScript workspaces.
- `library.json`: the library-focused preset that adds declaration and composite settings on top of `base.json`.
- `vite-app.json`: the app-focused preset that adds DOM libraries on top of `base.json`.
- `package.json`: export map for the shared JSON presets.

## 3. Core Behaviors & Patterns
- **Preset layering**: `base.json` holds the strict defaults, and the other presets only add the small deltas needed for libraries or Vite apps. New presets should follow that layering pattern instead of copying the full option set again.
- **Shared strictness**: The baseline enables strict typing, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, explicit module behavior, and other guardrails that downstream workspaces inherit by default.
- **Config-only boundary**: This workspace exports JSON presets only. Keep executable tooling, lint rules, and workspace-specific overrides out of this package.

## 4. Conventions
- **Files**: Keep presets as small JSON files with clear names that describe the intended consumer, such as `library.json` and `vite-app.json`.
- **Extends flow**: Downstream `tsconfig.json` files should extend one of these presets, then add only local include paths, path aliases, or emit behavior that the preset cannot know.
- **Change discipline**: Tighten or relax compiler behavior here only when the change is intended for multiple workspaces, because every consumer inherits the preset exports.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `packages/config-typescript` structure, patterns, and conventions.
