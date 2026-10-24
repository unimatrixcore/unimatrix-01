---
name: lab-prototype
description: Build, iterate on, or promote a prototype in the `lab` harness. Use when sketching UX before a feature exists — cloning a view out of an app into `lab/prototypes/`, designing one against the mocks, or moving a finished sketch into an app. Carries the procedure and the two clone seams; `lab/AGENTS.md` and `lab/prototypes/README.md` carry the facts.
---

# Prototyping in the lab

In Codex, read `.claude/runtime.md` for browser and skill-loading mechanics.

## Before you touch anything

Read `lab/AGENTS.md` and `lab/prototypes/README.md`. They hold every fact about the harness —
what the mocks are, what is banned, how the stylesheet is wired — and this skill deliberately
does not repeat them.

Work in the **main checkout**. `lab/prototypes/` is gitignored, and
`infra/scripts/link-worktree-dirs.mjs` symlinks its entries main-checkout → worktree and never the
reverse: a sketch written inside a worktree is invisible from the main checkout and goes with the
worktree when it is removed.

## Check the mocks have not drifted

Before designing against `@/mocks`, compare:

| Mock | Real |
| --- | --- |
| `LabApiClient` (`lab/src/mocks/api.ts`) | `ApiClient` (`packages/api-client/src/client.ts`) |
| `LabUserStore` (`lab/src/mocks/user-data.ts`) | `UserStore` (`packages/user-data/src/types.ts`) |
| `LabAssetUploader` (`lab/src/mocks/asset-upload.ts`) | `asset-upload.ts` (`apps/admin/src/features/content/asset-upload.ts`) |

Each is structurally copied rather than imported, so typecheck cannot see one diverge, and
importing the real thing to end the problem is off the table — `lab/AGENTS.md` says why.

**Report what is missing; do not decide it is a bug.** Each mock's doc comment states what it omits
on purpose. An omission with a stated reason is the design; one with no stated reason is drift, and
that is worth raising with the owner before you build on it.

## Clone a view out of an app

No app is a lab dependency and there is no alias or `paths` entry reaching `apps/*`, so this is
copying JSX, not importing it.

Crosses unchanged — the lab resolves these exactly as the apps do: `@unimatrix/ui`,
`@unimatrix/ui/public`, `@unimatrix/shared`, both `@unimatrix/chrome` entry points, and
`@unimatrix/auth`'s `.` entry.

Must be rewritten:

- `@unimatrix/api-client`, `@unimatrix/user-data` and `@unimatrix/auth/react` calls become `@/mocks`.
- `@tanstack/react-query` is not a lab dependency, so a `useQuery` becomes a `useEffect`/`useState`
  pair or a direct `await`.
- App-local CSS does not travel. See the styling rule in `lab/prototypes/README.md`.

## Look at it

`pnpm --filter @unimatrix/lab dev`, then open the printed URL.

`lab/prototypes/` is outside lint, typecheck and prettier, so the browser is the only thing that
reports on a prototype at all. Two failures are silent everywhere else: a class no `@source` line
reaches, and a file nested deeper than `lab/prototypes/*/*/`.

## Promote a sketch into an app

`@/mocks` does not exist in an app. Each call becomes the real client, store or session.

The prototype has never been linted, typechecked or formatted, so errors on its first run inside an
app are new obligations rather than regressions — budget for them.

Before pasting it anywhere, decide where the piece lives: root `AGENTS.md`'s "prefer shared-package
composition" rule picks the home, and it is much cheaper applied before the paste than after. The
target app's route split and shell rules are in that app's `AGENTS.md`.

Delete the prototype once it lands. It is untracked, so nothing removes it and the lab index keeps
listing it.
