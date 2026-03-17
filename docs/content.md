# Content workflow

This page defines the current public authored-content surface and the rules
for changing it. Use it when you add, edit, validate, or wire content into
the web app.

## Live content tree

The live public authored-content surface is intentionally limited to the
collections below.

```text
content/
  home/
    index.md
  projects/
    *.md
  blog/
    *.md
```

Current live domains are `home`, `projects`, and `blog`. `docs` and `notes`
remain reserved for later and are not current authored-content roots in this
repo.

## Public route surface

The current content collections map to the following public routes.

- `/` for the homepage and public orientation content
- `/projects` and `/projects/:slug` for the project listing and detail routes
- `/blog` and `/blog/:slug` for the writing listing and detail routes
- `/status` for the lightweight API status route

Unknown project and blog slugs intentionally fall into the app's not-found
experience instead of an unhandled content error.

## Authoring rules

Keep public authored content constrained to the current typed collection
model.

- Keep public authored content Git-backed under `content/`.
- Match frontmatter to the typed collection contracts in `packages/content`.
- Expect invalid or missing fields to fail with file-specific validation
  errors.
- Keep a markdown body after the frontmatter block for every current content
  file.
- The public site renders authored content with safe GitHub-flavored
  markdown.
- Raw HTML and executable MDX remain out of scope.
- Keep the public v1 content set curated. Repo-internal docs, policy pages,
  and future content domains stay out of scope unless a later issue expands
  the boundary.

## Authoring checklist

Use this sequence when you add a new public content file.

1. Create the markdown file under the correct live collection.
2. Match the frontmatter to the current typed schema in `packages/content`.
3. If you added `content/projects/*.md` or `content/blog/*.md`, update
   `apps/web/src/features/content/site-content.ts` in the same change.
4. Run the relevant content and web validation commands.

## Validation commands

Use the commands below to validate authored content and registry wiring.

```bash
pnpm --filter @unimatrix/content lint
pnpm --filter @unimatrix/content typecheck
pnpm --filter @unimatrix/content test
pnpm --filter @unimatrix/content build
pnpm --filter @unimatrix/web test
```

`apps/web/test/content-registry.test.ts` fails when project or blog files
exist on disk but are not wired into the web app.

## Docs versus public content

This repo keeps repo-operating docs and public content separate on purpose.

- `docs/` contains repo-internal operating documentation for contributors
  and agents.
- `content/` contains the public authored content that the web app renders.

Do not create repo-operating documents under `content/docs`. That path is
reserved for future public-site content, not internal contributor guidance.
