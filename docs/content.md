# Content Workflow

## Current content tree

The live public authored-content surface is currently:

```text
content/
  home/
    index.md
  projects/
    *.md
  blog/
    *.md
```

Current live domains are intentionally limited to:

- `home`
- `projects`
- `blog`

`docs` and `notes` are reserved for later and are not current authored-content roots in this repo.

## Current public route surface

- `/` for the homepage and public about/orientation content
- `/projects` and `/projects/:slug` for the project listing and detail routes
- `/blog` and `/blog/:slug` for the writing listing and detail routes
- `/status` for the lightweight API-status route

Unknown project and blog slugs intentionally fall into the app's not-found experience instead of an unhandled content error.

## Authoring and validation rules

- Keep public authored content Git-backed under `content/`.
- Match frontmatter to the typed collection contracts in `packages/content`.
- Expect invalid or missing fields to fail with file-specific validation errors.
- Keep a markdown body after the frontmatter block for all current content files.
- The public site renders authored content with safe GitHub-flavored markdown.
- Raw HTML and executable MDX remain out of scope.
- Keep the public v1 content set curated; repo-internal docs, policy pages, and other future content domains stay out of scope unless a later issue expands them.

Useful validation commands:

```bash
pnpm --filter @unimatrix/content lint
pnpm --filter @unimatrix/content typecheck
pnpm --filter @unimatrix/content test
pnpm --filter @unimatrix/content build
pnpm --filter @unimatrix/web test
```

## Manual content registry

`apps/web/src/features/content/site-content.ts` is still a manual raw-import registry for live authored content.

When you add new public files under `content/projects/*.md` or `content/blog/*.md`, update that registry in the same change. The guardrail for this is `apps/web/test/content-registry.test.ts`, which fails when authored project or blog files exist on disk but are not wired into the web app.

`content/home/index.md` is also imported explicitly and remains part of that same registry model.

## Repo docs vs public content

- `docs/` contains repo-internal operating documentation for contributors and agents.
- `content/` contains public authored content that the web app renders.

Do not create repo-operating documents under `content/docs` for this repo. That path is reserved for future public-site content, not for internal contributor guidance.
