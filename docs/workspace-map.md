# Workspace Map

## Current repo tree

```text
.
├── apps/
│   ├── api/
│   └── web/
├── content/
│   ├── blog/
│   ├── home/
│   └── projects/
├── docs/
│   ├── README.md
│   ├── content.md
│   ├── development.md
│   ├── operating-model.md
│   └── workspace-map.md
├── infra/
│   ├── deployment/
│   ├── docker/
│   └── scripts/
├── packages/
│   ├── api-client/
│   ├── config-eslint/
│   ├── config-typescript/
│   ├── content/
│   ├── db/
│   ├── shared/
│   └── ui/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Workspace purpose

| Path | Purpose |
| --- | --- |
| `apps/web` | Vite + React public web app, including TanStack Router routes, public content rendering, and the `/status` surface. |
| `apps/api` | Fastify API workspace with runtime config validation, request handling, and local dev server entrypoints. |
| `packages/ui` | Shared ShadCN-based UI primitives, styles, and UI-level test baseline for the monorepo. |
| `packages/shared` | Framework-agnostic shared contracts, schemas, and types. |
| `packages/api-client` | Typed client helpers for consuming API contracts from app code. |
| `packages/content` | Typed content collections, frontmatter validation, and repo-backed content loaders. |
| `packages/db` | Drizzle ORM and SQLite persistence baseline, including migration tooling. |
| `packages/config-typescript` | Shared strict TypeScript config presets for apps and packages. |
| `packages/config-eslint` | Shared ESLint flat config helpers for typed workspaces. |
| `content/` | Git-backed authored public content for the current live domains: `home`, `projects`, and `blog`. |
| `infra/` | Operational support surface for scripts, deployment documentation, and future local container assets. |

## Reserved / not present yet

The following paths are intentionally reserved but are not current live workspaces or content roots:

- `apps/workers`
- `content/docs`
- `content/notes`
- future packages such as `packages/bmd-parser`

Do not describe these as existing runtime surfaces until they are actually checked in and wired into the workspace.
