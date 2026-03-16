## Issue summary

- Linear issue: `LOC-43` — **8: Build the typed content system baseline for home, projects, and blog**.
- Goal: establish one small, typed, repo-backed content system for homepage/about content, projects, and blog entries in the new monorepo.
- Current repo context:
  - `packages/content` now owns explicit home/projects/blog collection metadata, frontmatter parsing/validation helpers, and repo-backed Node loaders.
  - `content/` now contains starter authored content for `home`, `projects`, and `blog`.
  - `apps/web` now exposes `/`, `/projects`, `/blog`, and `/status`, and the public routes consume the shared typed content baseline instead of hard-coded scaffold copy.
  - Legacy reference material exists in `../unimatrix-01-legacy/content/_index.md`, `../unimatrix-01-legacy/content/posts/`, and `../unimatrix-01-legacy/content/blog/`; use those as migration reference only, not as implementation architecture.

## Current status

- Issue code: `LOC-43`.
- Current Linear status: `In Progress`.
- Current branch status: `unimatrix-01/` is checked out on `feat/LOC-43-content-system-baseline`, created from current `main` (`80f9746`) during this implementation session.
- Current PR status: no PR exists yet; GitHub repo search returned zero PRs matching `LOC-43`.
- Implementation progress:
  - typed content contracts, parsing helpers, and repo-backed loaders are implemented in `@unimatrix/content`
  - starter content exists under `content/home`, `content/projects`, and `content/blog`
  - `apps/web` consumes the typed content baseline on `/`, `/projects`, and `/blog`
  - root and package documentation now describe the authoring workflow and deferred boundaries
- Linear progress comments added so far:
  - implementation started
  - typed content checkpoint complete
  - validation passing
  - ready for PR
- Last command that updated the file: `/issue:implement LOC-43` on `2026-03-16`.
- Blocked status:
  - Implementation: not blocked; the issue is implemented locally and validated.
  - Review: blocked until a PR is opened.
  - Close: blocked until the PR is merged and Linear can move to `Complete`.
  - Correction to prior blocker: no new package installs were ultimately required. The implementation used a small in-repo frontmatter parser plus Vite raw markdown imports for the web route consumers, so the earlier dependency-permission blocker is resolved and superseded.

## Proposed branch

- `feat/LOC-43-content-system-baseline`
- Branch type rationale: this is new platform capability work for the public-site content layer rather than a defect, regression, or hotfix.

## Pull request

- Current PR state: no PR exists yet.
- GitHub PR search status: no matching PR was found for `LOC-43` in `gwenphalan/unimatrix-01`.
- Branch/PR readiness: local issue branch `feat/LOC-43-content-system-baseline` contains the LOC-43 implementation and validation is passing; the branch is ready for PR creation against `main`.
- Expected PR shape: one branch, one PR, base branch `main`.
- PR description requirement: end the PR body with `Closes LOC-43`.

## Onboarding / prerequisites

- Use `./.issues/LOC-43.md` as the authoritative live issue record for implementation, PR, review, and close flows.
- If shared planning artifacts are created, keep plan-path references under `./.plan`.
- Confirm the local toolchain before implementation:
  - Node `22.x` (repo docs prefer `22.22.1`)
  - pnpm `10.30.3`
  - dependencies installed with `pnpm install --frozen-lockfile` if needed
- Before implementation, review these repo targets in `unimatrix-01/`:
  - `packages/content/src/collections.ts`
  - `packages/content/README.md`
  - `content/`
  - `apps/web/src/routes/index.tsx`
  - `apps/web/src/app/app-shell.tsx`
  - `apps/web/package.json`
  - `README.md`
- Before implementation, review these legacy reference paths for content shape only:
  - `../unimatrix-01-legacy/content/_index.md`
  - `../unimatrix-01-legacy/content/posts/`
  - `../unimatrix-01-legacy/content/blog/`
  - `../unimatrix-01-legacy/static/admin/config.yml`
- If implementation requires new parser or validation dependencies, add them through `pnpm` during the implementation command rather than editing manifests by hand.
- Before PR creation, confirm:
  - the branch was created from updated `main`
  - the content system stays Git-backed, typed, and small
  - no unsafe MDX or arbitrary content execution was introduced
  - validation results are recorded back into this file
- Before review, refresh this file with current implementation status, validation outcomes, Linear progress comments, and the PR URL.
- Before close, confirm the PR merged, local `main` is current, the issue branch is cleaned up if desired, and the Linear issue is ready to move to `Complete`.

## Pre-flight

- Fetch the latest changes from `origin/main` from `REPO_ROOT` before implementation; as of this record, `unimatrix-01/` has already been fetched and local `main` matches `origin/main` at `80f9746`.
- Review relevant code, tests, and docs before implementation in `REPO_ROOT`, especially `packages/content`, the empty `content/` tree, current `apps/web` routes/navigation, and the root/package READMEs.
- Treat `./.issues/LOC-43.md` as the canonical source of truth for the live issue record.
- Keep any shared workflow plan-path references on `./.plan`.
- Confirm there is still no existing `LOC-43` branch or PR before creating new work.

## Lifecycle steps

1. Move the Linear issue to `In Progress` when active implementation starts. ✅ Done during this session.
2. Create `feat/LOC-43-content-system-baseline` from updated `main`. ✅ Done during this session.
3. Implement the work in ordered steps: ✅ Complete locally.
   - define the in-scope content domain model and file layout
   - build typed schemas and loading helpers in `@unimatrix/content`
   - add starter repo-backed content for home, projects, and blog
   - wire the web app to consume that typed content baseline
   - document the authoring and validation workflow
4. Add progress comments to the Linear issue during implementation at meaningful milestones. ✅ Done during this session.
5. Open a pull request, link it back to the Linear issue, and end the PR description with `Closes LOC-43`.
6. Move the Linear issue to `Complete` after the PR is merged.
7. Reuse `./.issues/LOC-43.md` in fresh sessions for implementation, PR, review, and close flows so workflow state stays current.

## Implementation plan

1. Finalize the in-scope content model and repo layout.
   - Expand the placeholder `packages/content` collection definitions into an explicit contract for homepage/about content, projects, and blog, and define the repo-backed file layout rooted at `content/`.
   - Acceptance criteria:
     - the in-scope domains are explicit and limited to home/about, projects, and blog
     - file locations for each domain are documented before deeper implementation begins
     - `docs` and `notes` remain clearly out of scope for this issue unless a concrete dependency is discovered

2. Build typed schemas and loaders inside `@unimatrix/content`.
   - Add explicit frontmatter/content schemas plus repo-backed loading helpers that can read, validate, and return typed content for all three in-scope domains while keeping UI and transport concerns out of the package.
   - Acceptance criteria:
     - `@unimatrix/content` exports one coherent typed API for loading home/about, projects, and blog content
     - invalid frontmatter or missing required fields fail with actionable, file-specific validation errors
     - the package boundary stays small and does not absorb app-specific rendering logic

3. Create the initial authored content baseline under `content/`.
   - Add the starter content files/directories for home/about, projects, and blog using the legacy site only as reference for editorial shape and domain mapping, including the legacy `posts` → new `projects` translation.
   - Acceptance criteria:
     - `content/` contains valid starter entries for home/about, projects, and blog
     - project content lives under a new `content/projects/` path rather than keeping the Hugo-era `posts` name
     - all starter content passes the new typed loader without relying on Hugo-specific behavior

4. Wire the typed content baseline into `apps/web`.
   - Replace hard-coded homepage scaffold content with data loaded from `@unimatrix/content`, and add the route-facing content consumption needed for projects and blog so the public site reads from the shared content system rather than inline constants.
   - Acceptance criteria:
     - the `/` route sources its content from the typed content system
     - projects and blog have explicit route-level consumers or route stubs backed by typed content data
     - `apps/web` consumes `@unimatrix/content` through declared workspace boundaries instead of ad hoc filesystem reads

5. Document the authoring workflow and boundaries.
   - Update the root and package docs so contributors know where content lives, which frontmatter fields are required, how validation failures surface, and which content work is intentionally deferred.
   - Acceptance criteria:
     - `README.md` and `packages/content/README.md` describe the actual content layout and commands in use
     - required vs optional content fields are clear for each in-scope domain
     - Borg Markdown and broader CMS concerns are explicitly called out as future work, not silently folded into this issue

6. Add targeted validation for the new content system.
   - Replace the current placeholder `@unimatrix/content` test posture with focused automated checks for schema parsing/loading and run the relevant workspace and repo validation commands.
   - Acceptance criteria:
     - `@unimatrix/content` has real automated coverage for valid and invalid content cases
     - `pnpm --filter @unimatrix/content lint`, `pnpm --filter @unimatrix/content typecheck`, `pnpm --filter @unimatrix/content test`, and `pnpm --filter @unimatrix/content build` pass
     - `pnpm --filter @unimatrix/web lint`, `pnpm --filter @unimatrix/web typecheck`, `pnpm --filter @unimatrix/web test`, and `pnpm --filter @unimatrix/web build` pass
     - repo-level confidence is rechecked with `pnpm check` before PR creation

## Validation

- Completed targeted package validation:
  - `pnpm --filter @unimatrix/content lint` ✅
  - `pnpm --filter @unimatrix/content typecheck` ✅
  - `pnpm --filter @unimatrix/content test` ✅
  - `pnpm --filter @unimatrix/content build` ✅
- Completed web validation:
  - `pnpm --filter @unimatrix/web lint` ✅
  - `pnpm --filter @unimatrix/web typecheck` ✅
  - `pnpm --filter @unimatrix/web test` ✅
  - `pnpm --filter @unimatrix/web build` ✅
- Completed repo-level validation:
  - `pnpm check` ✅
- Validation notes:
  - the `@unimatrix/content` tests intentionally introduce invalid frontmatter and confirm file-specific validation failures
  - the web build regenerated the TanStack route tree and proved the new `/projects` and `/blog` routes compile cleanly
  - the current baseline keeps markdown non-executable; no unsafe MDX or arbitrary execution path was introduced
  - browser-interactive manual verification was not run in this session, but the route surfaces compile and typecheck against repo-backed content

## Risks / open questions

- Assumption confirmed in implementation: LOC-43 includes wiring the web app to consume the new typed content baseline, not only package-level schemas/loaders.
- The homepage/about storage shape is currently a single `content/home/index.md` document; future issues can refine that contract if the public site needs more structure.
- No new parser dependencies were required for this baseline, but future content complexity may justify adopting a dedicated parser through `pnpm` with explicit approval.
- Legacy `content/posts/` represents projects conceptually, so the migration must preserve editorial meaning while intentionally dropping Hugo-specific naming and conventions.
- Keep markdown handling safe and maintainable; Borg Markdown ideas can inform the future, but executable MDX/CMS expansion is out of scope for LOC-43.

## Recommended next command

- `/issue:pr`