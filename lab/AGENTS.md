# AGENTS.md

## 1. Overview

`lab` (package `@unimatrix/lab`) is the UX prototyping harness: a surface for designing UX before a feature is built — where a button goes, how a view is laid out — so that tuning does not happen inside a real app against real data. It is a personal design tool. **It is not a component gallery, not a documentation site, and not shared with anyone.**

It is the third top-level workspace entry, alongside `apps/*` and `packages/*`, because it must be a workspace member to import `@unimatrix/ui` and `@unimatrix/chrome`.

Write prototypes in the main checkout and read `prototypes/README.md` before creating one. Compare any mock you use with its real interface, and verify the result in the browser before presenting it. Promotion replaces mock calls with real integrations and runs the target workspace’s checks.

## 2. The defining constraint: local-dev only

`pnpm --filter @unimatrix/lab dev` and nothing else. **No `build` script, no Dockerfile, no compose file, no domain, no CI `Images` entry, and no route in any deployed app.** This is what makes the whole security question disappear: prototype code has no production surface to leak onto. If a change here creates a deploy artifact of any kind, it has misread what this workspace is.

Why not a `lab.unimatrix-01.dev` subdomain, since that was the obvious alternative: `docs/deployment.md` documents Clerk sessions as shared across **all** `*.unimatrix-01.dev` subdomains, and API CORS allows `https://*.unimatrix-01.dev`. A prototype served from such a subdomain would receive the admin's Clerk cookie *and* be an allowed CORS origin against the API — a credentialed path to admin routes from the least-reviewed code in the repo. A cross-origin iframe is not a boundary when the origins share a cookie parent.

## 3. Folder Structure

- `src/app`: `router.tsx` (hand-written, code-based routing — no `@tanstack/router-plugin`, no `routeTree.gen.ts`) and `lab-shell.tsx` (`ToolShell` from `@unimatrix/chrome/tool`, wired with the mock account control). The shell wraps the **index only** — a prototype gets the bare viewport.
- `src/routes`: `prototype-index.tsx` (the list) and `prototype-host.tsx` (renders one prototype and nothing else).
- `src/lib/prototype-registry.ts`: `import.meta.glob` discovery of `lab/prototypes/**/*.tsx`.
- `src/mocks`: the only data surface a prototype may use. See below.
- `prototypes/`: gitignored working-tree sketches — only `.gitkeep` and `README.md` are tracked. See `prototypes/README.md`.

## 4. Mocks

`src/mocks/` stands in for anything a prototype must not or cannot reach, so a signed-in admin view can be prototyped with **no Clerk keys, no API running and no database**:

- `api.ts` — `LabApiClient`, a structural stand-in for `@unimatrix/api-client`'s content surface. In-memory, mutable, reset by a reload.
- `user-data.ts` — `LabUserStore`, a structural stand-in for `@unimatrix/user-data`'s `UserStore`.
- `asset-upload.ts` — `LabAssetUploader`, a structural stand-in for `apps/admin/src/features/content/asset-upload.ts`, the CMS's own upload module rather than `LabApiClient` above: the real flow is two non-JSON, multipart routes that `@unimatrix/api-client` does not carry, so the admin app owns them directly. `uploadAsset` returns real metadata for a real `File` (SHA-256 hashed with `crypto.subtle`) but resolves the delivery URL to a `URL.createObjectURL` blob, because there is no API here to serve one back. `LAB_ASSET_ACCEPT` is a hand-kept copy of the API's `INLINE_SAFE_CONTENT_TYPES` allowlist. Two limits are load-bearing enough to read before reaching for it: a `blob:`/`data:` `assetUrl()` result renders in a plain `<img>` but is silently blank inside `PublicMarkdown`, whose sanitizer accepts only root-relative or `https?:` sources; and an upload here is invisible to `createLabApiClient().listAssets()` — two separate in-memory stores standing in for the one `contentAssetsTable` the real routes share.
- `session.tsx` — `LabSession` fixtures and `MockAccountControl`, standing in for a Clerk session and `<UserButton />`.
- `fixtures.ts` — the seed rows.
- `api-base-url.ts` — a hardcoded `http://localhost:3000`, asserted local at module load.

**Every mock is typed against the real contracts**, so a contract change breaks the mock at typecheck rather than letting a prototype validate against a fiction. Request/response and data shapes come from `@unimatrix/shared`; the permission shapes come from `@unimatrix/auth`'s `.` entry, which is where they live and which is framework-agnostic, dependency-free code.

`LabApiClient`, `LabUserStore` and `LabAssetUploader` are *structurally* copied rather than imported. `@unimatrix/api-client` and `@unimatrix/user-data` are not dependencies of this workspace and are lint errors here, because importing either would put a working, credential-taking transport one import away from every prototype. Local-only hosting removes the production-bundle risk but not that one: a prototype holding the real client with a base URL pointed at `https://api.unimatrix-01.dev` can mutate live content from a laptop. `LabAssetUploader` is copied for the same underlying reason as the other two, by a different route: it stands in for a module that lives inside `apps/admin`, and no app is a dependency of any workspace here.

Keep `LabUserStore` in step with `packages/user-data/src/types.ts` by hand. If that stops being a small, stable interface, the answer is a types-only entry point on that package — not a dependency here.

## 5. Conventions

- **Scripts are `dev`, `lint` and `typecheck` only.** No `test` (turbo would run it against a harness with no tests) and no `build` (nothing builds the lab, and a `build` script would put it in `pnpm verify`'s `turbo run build` for nothing).
- **`prototypes/` is excluded from lint, typecheck and prettier**, and included in the stylesheet's `@source` globs. A half-finished sketch must not be a failing check; a prototype with no Tailwind output would be useless.
- **`@unimatrix/ui` and `@unimatrix/shared` resolve to package *source*** through `vite.config.ts` aliases and `tsconfig.json` paths — the same wiring the apps that consume them carry. Both are built with `tsc` and publish `./dist` via their `exports` map, so without the alias, editing a shared component shows nothing here until a rebuild — which defeats the entire purpose.
- **`@tanstack/react-router` is in `dedupe`** alongside `react`/`react-dom`. `@unimatrix/chrome` declares it as a peer; two resolved copies means the shell's `useRouterState` reads a router context `RouterProvider` never wrote to.
- **The stylesheet turns Tailwind's automatic source detection off (`source(none)`) and lists every scanned path itself.** Unlike the apps, this is not a convenience: `lab/prototypes/` is gitignored, Tailwind skips gitignored paths, and while automatic detection is on its workspace-wide source makes that filter apply to every other `@source` too — so no directive of any shape reaches a prototype. The reasoning, the measurement and the per-depth prototype lines are in `src/styles.css`; read the comments there before editing any line of it. Nothing but a browser catches a mistake — lint, types and every automated check stay green while prototypes render half-styled.
- **Banned imports** (enforced by `no-restricted-imports` in `eslint.config.mjs`, and **only under `lab/src/`** — `lab/prototypes/` is excluded from lint, so nothing stops a prototype importing them; containment is the absence of a deploy artifact, not this rule): `@unimatrix/api-client`, `@unimatrix/user-data`, `@unimatrix/auth/react`, `@unimatrix/auth/server`, `@clerk/*`. The bare `@unimatrix/auth` entry is allowed and used — it is the permission scheme, and nothing else.

## 6. Known costs, accepted rather than solved

- `pnpm install` installs lab's dependencies in CI, which never needs them.
- **Dependabot watches `lab/package.json`** and will open PRs for a dev-only harness. Accepted deliberately: an unsupported or malformed key makes Dependabot reject `.github/dependabot.yml` entirely, silently disabling npm updates repo-wide, and a rejected config looks exactly like a quiet week. A few dev-harness PRs is the cheaper failure.
- A prototype rots against `packages/ui` and `packages/chrome` changes. Correct for throwaway work.
