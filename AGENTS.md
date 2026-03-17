# Agent instructions

## Package manager
- Use `pnpm`.
- Core commands: `pnpm install`, `pnpm setup:local`, `pnpm dev`,
  `pnpm check`, `pnpm verify`.
- If local Node or pnpm do not match `.node-version` and the root
  `packageManager` field, use
  `./infra/scripts/pnpm-with-node22.sh ...`.

## Source of truth
- Human docs: `docs/README.md`.
- Deployment contract: `infra/deployment/README.md`.
- Package boundaries: package-level `README.md` files under `packages/`.
- The nearest `AGENTS.md` overrides this file.

## Live surface
- Apps: `apps/web`, `apps/api`
- Packages: `packages/ui`, `packages/shared`, `packages/api-client`,
  `packages/content`, `packages/db`, `packages/config-typescript`,
  `packages/config-eslint`
- Content: `content/home`, `content/projects`, `content/blog`
- Ops/docs: `docs/`, `infra/scripts`, `infra/deployment`, `infra/docker`

## Reserved, not live
- `apps/workers`
- `content/docs`
- `content/notes`
- Future packages such as `packages/bmd-parser`

## Scoped commands
| Task | Command |
| --- | --- |
| Lint one file | `pnpm exec eslint path/to/file.ts` |
| Run one web unit test file | `pnpm --filter @unimatrix/web exec vitest run path/to/test.tsx` |
| Run one API test file | `pnpm --filter @unimatrix/api exec node --import tsx --test path/to/test.ts` |
| Typecheck one workspace | `pnpm --filter @unimatrix/web typecheck` or `pnpm --filter @unimatrix/api typecheck` |

## Repo rules
- Use TypeScript, strict typing, named exports, and small composable
  modules.
- Prefer stable package boundaries over app-local duplication.
- Validate every external input boundary with Zod.
- Keep API handlers thin and move business logic into service modules.
- Preserve the frontend system: ShadCN UI, preset `aJMzyTw`, Geist Mono,
  zero-radius styling, Remix Icons, ADHD-accessible UX, and a
  desktop-first bias.
- Keep content Git-backed and safe-rendered. Never execute raw HTML, MDX,
  or generated code.
- When adding `content/projects/*.md` or `content/blog/*.md`, update
  `apps/web/src/features/content/site-content.ts` in the same change.
- Treat `docs/` as repo-internal guidance and `content/` as public site
  content.

## Validation
- Minimum gate: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Use `pnpm verify` for cross-workspace or runtime-surface changes.

## Ask first
- Switching away from Vite, Fastify, pnpm, or Turborepo
- Moving from SQLite to Postgres before a real need exists
- Introducing a headless CMS
- Making major package-boundary changes

## Commit attribution
- If you are a Codex agent and you create commits, add
  `Co-Authored-By: Codex <noreply@openai.com>`.
- If you are a Claude Code agent and you create commits, add
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
