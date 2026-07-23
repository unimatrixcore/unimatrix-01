# Workspace map

This page maps the current repo tree to ownership boundaries. Use it when you
need to decide where code, docs, content, or infra changes belong.

## Current repo tree

The tree below reflects the current live workspace layout.

```text
.
├── apps/
│   ├── api/
│   ├── auth/
│   ├── cube-trainer/
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
│   ├── auth/
│   ├── config-eslint/
│   ├── config-typescript/
│   ├── content/
│   ├── db/
│   ├── shared/
│   ├── ui/
│   └── user-data/
├── AGENTS.md
├── package.json
├── pnpm-workspace.yaml
└── turbo.json
```

## Workspace responsibilities

Use the table below to place work in the narrowest correct boundary.

| Path | Purpose | Local reference |
| --- | --- | --- |
| `apps/web` | Vite + React public site, TanStack Router routes, and public content rendering | `apps/web/package.json` |
| `apps/api` | Fastify API workspace with runtime config validation and request handling | `apps/api/package.json` |
| `apps/cube-trainer` | Vite + React OLL/PLL algorithm trainer, no backend dependency | `apps/cube-trainer/AGENTS.md` |
| `apps/auth` | Vite + React accounts app: the central Clerk-backed authentication hub (sign-in/sign-up, account management, permission admin) | `apps/auth/package.json` |
| `packages/ui` | Shared ShadCN-based UI primitives and shared styles | `packages/ui/README.md` |
| `packages/shared` | Framework-agnostic shared contracts, schemas, and types | `packages/shared/README.md` |
| `packages/api-client` | Typed client helpers that consume shared contracts | `packages/api-client/README.md` |
| `packages/content` | Typed content collections, frontmatter validation, and repo-backed loaders | `packages/content/README.md` |
| `packages/db` | Drizzle ORM and SQLite persistence baseline, including migration tooling | `packages/db/README.md` |
| `packages/auth` | Shared Clerk-backed auth and permission scheme, with Fastify and React integration layers | `packages/auth/README.md` |
| `packages/user-data` | Per-user settings and file storage, with an account adapter and an optional browser-only guest mode | `packages/user-data/README.md` |
| `packages/config-typescript` | Shared strict TypeScript config presets | `packages/config-typescript/package.json` |
| `packages/config-eslint` | Shared ESLint flat-config helpers | `packages/config-eslint/package.json` |
| `content/` | Git-backed public authored content for `home`, `projects`, and `blog` | `docs/content.md` |
| `docs/` | Repo-internal operating documentation | `docs/README.md` |
| `infra/` | Scripts, deployment docs, and local container posture | `infra/deployment/README.md` |

## Reserved roots

The paths below are intentionally reserved but are not current live
workspaces or content roots.

- `apps/workers`
- `content/docs`
- `content/notes`
- Future packages such as `packages/bmd-parser`

Do not describe these paths as existing runtime surfaces until they are
actually checked in and wired into the workspace.
