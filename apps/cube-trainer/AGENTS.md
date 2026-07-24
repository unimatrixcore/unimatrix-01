# AGENTS.md

## 1. Overview
`apps/cube-trainer` is the Vite + React app for learning and drilling 3x3 Rubik's Cube OLL and PLL last-layer algorithms. It has no backend dependency: algorithm data is bundled at build time, and per-case learning progress and the training pool are kept in the browser's `localStorage`.

## 2. Folder Structure
- `src/app`: router creation and the app shell (skip-link + centered `<main>` + footer; no persistent nav bar).
- `src/features/algorithms`: algorithm case data (`*.data.ts`, scraped from jperm.net/algs), `algorithm-sets.ts` (the `AlgorithmSet` registry), `types.ts`, `derive-diagram.ts` (maps a case to its last-layer diagram), `use-case-pool.ts`/`use-case-progress.ts` (hooks over the two `localStorage` stores below), and components including the OLL/PLL segmented toggle, case preview card, algorithm group section, and case category filter.
- `src/features/cube`: the cube-notation/diagram engine — `engine.ts` (move/notation application over a cube model), `model.ts` (facelet model), `notation.ts` (move-string parsing), `last-layer-diagram.ts` (derives a last-layer diagram from a case), and `components/last-layer-diagram-view.tsx` (renders it). This is the shared computational core behind case previews and diagrams; it is not scraped data like `algorithms/*.data.ts`.
- `src/features/learn`: guided teaching flow — session hook (`use-learn-session.ts`), fixed group+weight case ordering (`learn-case-order.ts`), and the panel/cases-grid/set-view components. The cases grid also reads (but does not write) case progress to filter to learned cases.
- `src/features/trainer`: keyboard-driven drill flow — trainer hook (`useAlgorithmTrainer`), weighted case selection (`pick-next-case.ts`), case setup, and the panel/cases-grid/set-view components.
- `src/features/cube-trainer-site`: app-owned layout compositions (page container, footer).
- `src/lib/progress-storage.ts`: Zod-validated `localStorage` read/write for per-case learned status (`new` | `learning` | `known`); written only by Learn, but also read by Drill's cases grid to filter/badge by learned status.
- `src/lib/pool-storage.ts`: Zod-validated `localStorage` read/write for the per-case training pool (manual enable/disable), used only by Drill's case-picker.
- `src/routes`: file-based route loaders and lazy route components; keep paired `*.ts(x)` and `*.lazy.tsx` files aligned. Routes are `/` (Learn-vs-Drill chooser), `/learn`, and `/drill`. `routeTree.gen.ts` is generated and should not become a hand-edited source of truth.
- `src/styles.css`: app-specific presentation layered on top of `@unimatrix/ui/styles.css`.
- `test`: Vitest coverage for algorithm data integrity (`algorithm-sets.test.ts`), the cube engine (`cube-engine.test.ts`), last-layer diagram derivation (`last-layer-diagram.test.ts`), learn case ordering, drill case setup/selection (`case-setup.test.ts`, `pick-next-case.test.ts`), pool storage, and progress storage.
- `e2e`: Playwright smoke coverage for the running app.

## 3. Core Behaviors & Patterns
- **Algorithm data provenance**: `oll-algorithms.data.ts` and `pll-algorithms.data.ts` were generated from jperm.net's own trainer data files (`/lib/oll.js`, `/lib/pll.js`), not hand-transcribed. If the upstream algorithm sets change, regenerate rather than hand-editing individual entries.
- **Learn vs Drill, not Browse vs Trainer**: `/` is a mode chooser; the OLL/PLL toggle lives inside `/learn` and `/drill`, not as separate top-level routes. Learn walks unknown cases in a fixed group+weight teaching order (`orderedLearnCases`) and marks a case "known" directly when the user acts on it — learned-status IS the toggle in Learn's case grid, there is no separate hide-from-learn flag. Drill drills whatever is manually enabled in the training pool, independent of learned status.
- **Two independent per-case stores**: `progress-storage.ts` (learned status: new/learning/known, written only by Learn but also read by Drill's cases grid to filter/badge by learned status) and `pool-storage.ts` (training pool: boolean enabled/disabled, read/written only by Drill's case-picker) are separate `localStorage` keys (`cube-trainer:progress:<setId>` and `cube-trainer:pool:<setId>`) and do not sync with each other.
- **Weighted practice**: `pickNextCase` draws the next flashcard weighted by each case's `probabilityWeight` (drawn from jperm's real-world PLL/OLL case frequency), avoiding immediate repeats when more than one case remains.
- **Fully keyboard-driven**: Drill uses Space to advance to the next drill case; Learn uses ArrowLeft/ArrowRight to move back/forward through the teaching order and Space to mark the current case learned. Neither panel has on-screen "Next"/"Back"/"Got it" buttons.

## 4. Conventions
- **Route files**: Use TanStack Router file naming (`learn.tsx` + `learn.lazy.tsx`, `drill.tsx` + `drill.lazy.tsx`, etc.), matching `apps/web`.
- **Imports**: Group external imports first, then `@/` aliases, then relative imports. Prefer `@unimatrix/ui/public` over the full `@unimatrix/ui` surface.
- **Naming**: Components use `PascalCase`; helpers and data modules use `camelCase` exports from kebab-case files.
- **No backend/API dependency**: this app intentionally does not depend on `@unimatrix/api-client`, `@unimatrix/shared`, `@unimatrix/content`, or `@tanstack/react-query` — keep it that way unless a real server-backed feature (e.g. cross-device sync) is added.

## 5. Working Agreements
- Follow the shared repo working agreements in the root `AGENTS.md`; this file only adds `apps/cube-trainer` structure, patterns, and conventions.
