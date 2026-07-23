# AGENTS.md

## 1. Overview
`apps/cube-trainer` is the Vite + React app for learning and drilling 3x3 Rubik's Cube OLL and PLL last-layer algorithms. It has no backend dependency: algorithm data is bundled at build time and per-case learning progress is kept in the browser's `localStorage`.

## 2. Folder Structure
- `src/app`: router creation and app shell/navigation.
- `src/features/algorithms`: algorithm case data (`*.data.ts`, scraped from jperm.net/algs), the `AlgorithmSet` registry, grouping helpers, and the browse-mode components.
- `src/features/trainer`: flashcard trainer hook (`useAlgorithmTrainer`), weighted case selection, and the trainer panel component.
- `src/features/cube-trainer-site`: app-owned layout compositions (page container, footer, section heading).
- `src/lib/progress-storage.ts`: Zod-validated `localStorage` read/write for per-case status (`new` | `learning` | `known`).
- `src/routes`: file-based route loaders and lazy route components; keep paired `*.ts(x)` and `*.lazy.tsx` files aligned. `routeTree.gen.ts` is generated and should not become a hand-edited source of truth.
- `src/styles.css`: app-specific presentation layered on top of `@unimatrix/ui/styles.css`.
- `test`: Vitest coverage for algorithm data integrity and progress storage.
- `e2e`: Playwright smoke coverage for the running app.

## 3. Core Behaviors & Patterns
- **Algorithm data provenance**: `oll-algorithms.data.ts` and `pll-algorithms.data.ts` were generated from jperm.net's own trainer data files (`/lib/oll.js`, `/lib/pll.js`), not hand-transcribed. If the upstream algorithm sets change, regenerate rather than hand-editing individual entries.
- **Two view modes per set**: `AlgorithmSetView` toggles between "Trainer" (flashcard recall with reveal/known/learning/skip) and "Browse" (full grouped reference list) for a given `AlgorithmSetId` ("oll" | "pll").
- **Weighted practice**: `pickNextCase` draws the next flashcard weighted by each case's `probabilityWeight` (drawn from jperm's real-world PLL/OLL case frequency), avoiding immediate repeats when more than one case remains.
- **Progress persistence**: both Browse and Trainer modes read/write the same `localStorage` key per set (`cube-trainer:progress:<setId>`) via `useCaseProgress`; each mode independently loads progress on mount rather than sharing live state, since only one mode is rendered at a time.

## 4. Conventions
- **Route files**: Use TanStack Router file naming (`oll.tsx` + `oll.lazy.tsx`, etc.), matching `apps/web`.
- **Imports**: Group external imports first, then `@/` aliases, then relative imports. Prefer `@unimatrix/ui/public` over the full `@unimatrix/ui` surface.
- **Naming**: Components use `PascalCase`; helpers and data modules use `camelCase` exports from kebab-case files.
- **No backend/API dependency**: this app intentionally does not depend on `@unimatrix/api-client`, `@unimatrix/shared`, `@unimatrix/content`, or `@tanstack/react-query` — keep it that way unless a real server-backed feature (e.g. cross-device sync) is added.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `apps/cube-trainer` structure, patterns, and conventions.
