# Content workflow

## Where content lives

Edit homepage and About copy in `apps/web/src/features/content/home.md`.
`site-content.ts` parses it into the web app bundle. Keep the heading available
when the content API is unreachable.

Blog and project entries live in the content database behind the API. Create,
edit, and publish them through `apps/admin`; publishing changes the live site
without a deploy. The web app fetches these entries at runtime through
`apps/web/src/features/content/queries`.

## Public routes

- `/` combines app-owned copy with featured projects and recent blog entries.
- `/about` uses app-owned copy.
- `/projects` and `/projects/:slug` show project listings and details.
- `/blog` and `/blog/:slug` show blog listings and details.

Unknown project and blog slugs render the app's not-found experience.

## Authoring and validation

Blog and project input follows the content contracts in `packages/shared`.
Authored bodies render as safe GitHub-flavored Markdown; raw HTML and executable
MDX must not execute. Repo-operating documentation belongs under `docs/`.

For homepage or About copy changes, run the web unit and smoke suites and check
the rendered pages in a browser:

```bash
pnpm --filter @unimatrix/web test:unit
pnpm --filter @unimatrix/web test:smoke
```

`apps/web/test/content-registry.test.ts` fails if blog or project Markdown is
imported into the web bundle alongside the database.
