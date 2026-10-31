import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

function findRepositoryRoot(startDir: string): string {
  let currentDir = startDir;

  while (!existsSync(join(currentDir, "pnpm-workspace.yaml"))) {
    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not locate the repository root from ${startDir}.`);
    }

    currentDir = parentDir;
  }

  return currentDir;
}

const repositoryRoot = findRepositoryRoot(process.cwd());

/**
 * Collapses each `{ ... }` specifier list onto a single line and drops the
 * trailing comma Prettier leaves behind when it wraps one.
 *
 * The assertions below are about *which* symbols a barrel re-exports and from
 * where — not about how the statement is wrapped. Matching the raw source made
 * them fail the moment Prettier split a long export list across lines, which
 * says nothing about the package boundary this test exists to protect.
 */
function collapseExportSpecifiers(source: string): string {
  return source.replace(/\{[^}]*\}/gu, (block) =>
    block.replace(/\s+/gu, " ").replace(/,\s*\}$/u, " }"),
  );
}

/**
 * Drops block and line comments so a source assertion cannot be satisfied by
 * prose that merely mentions the symbol it is looking for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function readRepositoryFile(path: string): string {
  return readFileSync(join(repositoryRoot, path), "utf8");
}

function collectRepositoryFiles(path: string): string[] {
  const absolutePath = join(repositoryRoot, path);
  const entries = readdirSync(absolutePath, { withFileTypes: true });

  return entries.flatMap((entry) => {
    const relativePath = join(path, entry.name);

    if (entry.isDirectory()) {
      return collectRepositoryFiles(relativePath);
    }

    return relativePath;
  });
}

describe("public UI package usage", () => {
  it("@unimatrix/ui remains broad while @unimatrix/ui/public stays intentionally narrow", () => {
    const rootSource = readRepositoryFile("packages/ui/src/index.ts");
    const publicSource = readRepositoryFile("packages/ui/src/public.ts");
    const uiBarrelSource = readRepositoryFile("packages/ui/src/components/ui/index.ts");
    const collapsedPublicSource = collapseExportSpecifiers(publicSource);
    const publicExportLines = collapsedPublicSource.match(/^export \{ .* \} from ".*";$/gmu) ?? [];
    const expectedPublicExportLines = [
      'export { Badge } from "./components/ui/badge.js";',
      'export { Button } from "./components/ui/button.js";',
      'export { Card } from "./components/ui/card.js";',
      'export { GraphBackground } from "./components/graph-background.js";',
      'export { HealthHistory } from "./components/health-history.js";',
      'export { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";',
      'export { Kbd, KbdGroup } from "./components/ui/kbd.js";',
      'export { Separator } from "./components/ui/separator.js";',
      'export { Switch } from "./components/ui/switch.js";',
      'export { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group.js";',
      'export { PublicMarkdown } from "./components/public-markdown.js";',
      'export { useIsMobile } from "./hooks/use-mobile.js";',
      'export { cn } from "./lib/utils.js";',
    ];

    expect(rootSource).toMatch(/components\/ui\/index/u);
    expect(rootSource).toMatch(/PublicMarkdown/u);
    expect(rootSource).toMatch(/cn/u);
    expect(uiBarrelSource).toMatch(/accordion/u);
    expect(uiBarrelSource).toMatch(/dialog/u);
    expect(uiBarrelSource).toMatch(/sidebar/u);
    expect(rootSource).not.toMatch(/PublicAppFrame/u);
    expect(rootSource).not.toMatch(/PublicPageContainer/u);
    expect(rootSource).not.toMatch(/PublicSectionHeading/u);
    expect(rootSource).not.toMatch(/PublicContentParagraphs/u);
    expect(rootSource).not.toMatch(/PublicProjectCard/u);
    expect(rootSource).not.toMatch(/PublicPostListItem/u);

    expect(publicExportLines).toHaveLength(expectedPublicExportLines.length);
    for (const line of expectedPublicExportLines) {
      expect(collapsedPublicSource).toContain(line);
    }
    expect(publicSource).not.toMatch(/accordion/u);
    expect(publicSource).not.toMatch(/dialog/u);
    expect(publicSource).not.toMatch(/sidebar/u);
    expect(publicSource).not.toMatch(/sonner/u);
    expect(publicSource).not.toMatch(/vaul/u);
  });

  it("gives every API-backed route its own error component", () => {
    // Derived from the route files rather than hard-coded, so a route added
    // later is covered without anyone remembering to extend a list.
    const routeFiles = collectRepositoryFiles("apps/web/src/routes").filter(
      (path) => path.endsWith(".tsx") && !path.endsWith(".lazy.tsx"),
    );
    const missing = routeFiles.flatMap((routePath) => {
      if (!/ensureQueryData/u.test(stripComments(readRepositoryFile(routePath)))) {
        return [];
      }

      const lazyPath = routePath.replace(/\.tsx$/u, ".lazy.tsx");

      if (!existsSync(join(repositoryRoot, lazyPath))) {
        return [`${routePath} (no lazy sibling)`];
      }

      // Comments are stripped and the option's colon required: the first
      // version of this test matched the word inside the doc comment that
      // explains why the option is there, so deleting the option left it
      // green. Verified by deleting it again afterwards.
      const lazySource = stripComments(readRepositoryFile(lazyPath));

      return /errorComponent:\s*\S/u.test(lazySource) ? [] : [lazyPath];
    });

    // Not a style rule. Without an `errorComponent` a failed loader escapes to
    // the router's default, which replaces the root component — and with it the
    // `<HeadContent />` carrying the page's meta description. An unreachable API
    // then costs the homepage its description, which CI reports as a Lighthouse
    // SEO failure rather than as anything that looks like a routing bug.
    expect(missing).toEqual([]);
  });

  it("keeps the editor in its own entry point, out of the public site's graph", () => {
    const editorSource = readRepositoryFile("packages/ui/src/editor.ts");
    const publicSource = readRepositoryFile("packages/ui/src/public.ts");
    const rootSource = readRepositoryFile("packages/ui/src/index.ts");
    const uiPackageJson = readRepositoryFile("packages/ui/package.json");
    const webViteConfig = readRepositoryFile("apps/web/vite.config.ts");
    const adminViteConfig = readRepositoryFile("apps/admin/vite.config.ts");

    expect(editorSource).toMatch(/MarkdownEditor/u);
    expect(uiPackageJson).toContain('"./editor"');

    // Not a style rule, and not a hypothetical. A barrel's whole re-export
    // graph lands in the chunk importing it regardless of what is actually
    // used: adding `MarkdownEditor` to `./public` was measured at +497.6 kB
    // (+169.3 kB gzip) on the set `index.html` eagerly preloads, with no
    // importer anywhere in apps/web. `./public` is what every public route
    // imports and the root barrel is banned from apps/web outright (asserted
    // above), so neither may name the editor. Full measurement, including the
    // alternative causes ruled out, is in `packages/ui/src/editor.ts`.
    expect(publicSource).not.toMatch(/MarkdownEditor/u);
    expect(publicSource).not.toMatch(/markdown-editor/u);
    expect(rootSource).not.toMatch(/MarkdownEditor/u);

    // The editor is now an admin-only concern: apps/web never names it, and
    // apps/admin resolves the same prefix-anchored alias ordering (the bare
    // `@unimatrix/ui` entry would otherwise swallow the subpath).
    expect(webViteConfig).not.toMatch(/@unimatrix\\\/ui\\\/editor/u);
    expect(adminViteConfig.indexOf("@unimatrix\\/ui\\/editor")).toBeGreaterThan(-1);
    expect(adminViteConfig.indexOf("@unimatrix\\/ui\\/editor")).toBeLessThan(
      adminViteConfig.indexOf("find: /^@unimatrix\\/ui$/"),
    );
  });

  it("packages/ui owns the canonical shadcn config and shared stylesheet export", () => {
    expect(existsSync(join(repositoryRoot, "packages/ui/components.json"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "apps/web/components.json"))).toBe(false);

    const uiPackageJson = readRepositoryFile("packages/ui/package.json");
    const webStylesSource = readRepositoryFile("apps/web/src/styles.css");

    expect(uiPackageJson).toContain('"./styles.css"');
    expect(uiPackageJson).toContain('"./public"');
    expect(webStylesSource).toContain('@import "@unimatrix/ui/styles.css";');
    expect(webStylesSource).not.toContain('@import "shadcn/tailwind.css";');
    expect(webStylesSource).not.toContain('@import "@fontsource-variable/geist-mono";');
  });

  it("apps/web owns its public-site compositions while consuming shared ui primitives", () => {
    const publicSiteSource = readRepositoryFile("apps/web/src/features/public-site/components.tsx");

    // `PublicPageContainer` and `PublicSiteFooter` are deliberately absent:
    // both are chrome and now live in `@unimatrix/chrome/public`. What stays
    // here is app-owned public-site *composition*, which is the distinction
    // this case exists to hold.
    expect(publicSiteSource).not.toMatch(/PublicPageContainer/u);
    expect(publicSiteSource).not.toMatch(/PublicSiteFooter/u);
    expect(publicSiteSource).toMatch(/PublicSectionHeading/u);
    expect(publicSiteSource).toMatch(/PublicDecisionCard/u);
    expect(publicSiteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(publicSiteSource).toMatch(/PublicTransmissionListItem/u);
    expect(publicSiteSource).toMatch(/PublicMetadataStrip/u);
    expect(publicSiteSource).toMatch(/PublicNotice/u);
    expect(publicSiteSource).toMatch(/PublicReadingFrame/u);
    expect(publicSiteSource).toContain('from "@unimatrix/ui/public"');
    expect(publicSiteSource).not.toContain('from "@unimatrix/ui"');
  });

  it("apps/web source and tests avoid the root @unimatrix/ui barrel for runtime imports", () => {
    const sourceFiles = [
      ...collectRepositoryFiles("apps/web/src"),
      ...collectRepositoryFiles("apps/web/test"),
    ].filter((path) => /\.(ts|tsx)$/u.test(path) && !path.endsWith("routeTree.gen.ts"));

    const rootBarrelImports = sourceFiles.filter((path) =>
      /^\s*import\s.+from "@unimatrix\/ui";$/mu.test(readRepositoryFile(path)),
    );

    expect(rootBarrelImports).toEqual([]);
  });

  it("apps/web consumes shared primitives from @unimatrix/ui/public and keeps route composition in lazy files", () => {
    const appShellSource = readRepositoryFile("apps/web/src/app/app-shell.tsx");
    const publicShellSource = readRepositoryFile("packages/chrome/src/public-shell.tsx");
    const lazyMarkdownSource = readRepositoryFile(
      "apps/web/src/features/content/lazy-public-markdown.tsx",
    );
    const homeRouteSource = readRepositoryFile("apps/web/src/routes/index.tsx");
    const homeLazyRouteSource = readRepositoryFile("apps/web/src/routes/index.lazy.tsx");
    const projectsRouteSource = readRepositoryFile("apps/web/src/routes/projects.tsx");
    const projectsLazyRouteSource = readRepositoryFile("apps/web/src/routes/projects.lazy.tsx");
    const blogRouteSource = readRepositoryFile("apps/web/src/routes/blog.tsx");
    const blogLazyRouteSource = readRepositoryFile("apps/web/src/routes/blog.lazy.tsx");
    const aboutRouteSource = readRepositoryFile("apps/web/src/routes/about.tsx");
    const aboutLazyRouteSource = readRepositoryFile("apps/web/src/routes/about.lazy.tsx");
    const projectDetailRouteSource = readRepositoryFile("apps/web/src/routes/projects_.$slug.tsx");
    const projectDetailLazyRouteSource = readRepositoryFile(
      "apps/web/src/routes/projects_.$slug.lazy.tsx",
    );
    const blogDetailRouteSource = readRepositoryFile("apps/web/src/routes/blog_.$slug.tsx");
    const blogDetailLazyRouteSource = readRepositoryFile(
      "apps/web/src/routes/blog_.$slug.lazy.tsx",
    );

    // The shell delegates its chrome to `@unimatrix/chrome/public` rather than
    // building a header of its own. What must stay in the app is the knowledge
    // the package deliberately refuses to hold: the route-to-tab mapping and
    // the breadcrumb trail. The site is anonymous, so no `accountControl` is
    // passed at all (the same as apps/cflop).
    expect(appShellSource).toMatch(/from "@unimatrix\/chrome\/public"/u);
    expect(appShellSource).toMatch(/PublicShell/u);
    expect(appShellSource).toMatch(/Unimatrix-01/u);
    expect(appShellSource).not.toMatch(/accountControl=/u);
    expect(appShellSource).toMatch(/breadcrumbItems=/u);
    expect(appShellSource).not.toMatch(/aria-label="Primary"/u);

    // The header markup itself, pinned where it now lives. Both of these
    // encode measured fixes: the two-column mobile nav grid, and the landmark
    // name that keeps the two header bars from colliding under axe's
    // `landmark-unique` rule.
    expect(publicShellSource).toMatch(/grid-cols-2 gap-2 sm:flex/u);
    // Both bars render a nav landmark, and the two names must stay distinct —
    // two landmarks sharing a role and an accessible name is exactly what axe's
    // `landmark-unique` rule reports. The name arrives as a prop, so the
    // literal lives at the call sites and `aria-label` at the element.
    expect(publicShellSource).toMatch(/aria-label=\{label\}/u);
    expect(publicShellSource).toMatch(/label="Primary"/u);
    expect(publicShellSource).toMatch(/label="Primary, condensed header"/u);
    expect(publicShellSource).toMatch(/label="Breadcrumb"/u);
    expect(publicShellSource).toMatch(/label="Breadcrumb, condensed header"/u);
    // The breadcrumb trail must not be free to wrap: with it wrapping, the
    // trail stacks beside the `shrink-0` logo at 640-768px.
    expect(publicShellSource).toMatch(/flex min-w-0 flex-nowrap items-center gap-1/u);

    expect(lazyMarkdownSource).toMatch(/lazy\(/u);
    expect(lazyMarkdownSource).toMatch(/import\("@unimatrix\/ui\/public"\)/u);
    expect(lazyMarkdownSource).toMatch(/module\.PublicMarkdown/u);
    expect(lazyMarkdownSource).toMatch(/getDerivedStateFromError/u);
    expect(lazyMarkdownSource).toMatch(/Markdown content could not be loaded right now/u);

    expect(homeRouteSource).toMatch(/createFileRoute\("\/"\)/u);
    expect(homeRouteSource).toMatch(/loader/u);
    expect(homeRouteSource).toMatch(/ensureQueryData/u);
    expect(homeRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(homeLazyRouteSource).toMatch(/createLazyFileRoute\("\/"\)/u);
    expect(homeLazyRouteSource).toMatch(/@unimatrix\/ui\/public/u);
    expect(homeLazyRouteSource).toMatch(/PublicSectionHeading/u);
    expect(homeLazyRouteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(homeLazyRouteSource).toMatch(/PublicTransmissionListItem/u);
    expect(homeLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(homeLazyRouteSource).toMatch(/View all projects/u);
    expect(homeLazyRouteSource).toMatch(/xl:grid-cols-2 xl:items-stretch/u);
    expect(homeLazyRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    const homeRouteRenderLinkCount = (homeLazyRouteSource.match(/renderLink/gu) ?? []).length;
    expect(homeRouteRenderLinkCount).toBeGreaterThanOrEqual(2);
    expect(homeLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
    expect(homeLazyRouteSource).toMatch(/to="\/blog\/\$slug"/u);

    expect(projectsRouteSource).toMatch(/createFileRoute\("\/projects"\)/u);
    // Content is fetched from the API now: the non-lazy route file owns the
    // data (through the router's query client), the lazy file owns the UI.
    expect(projectsRouteSource).toMatch(/publishedPostsQueryOptions\("project"\)/u);
    expect(projectsRouteSource).toMatch(/ensureQueryData/u);
    expect(projectsRouteSource).not.toMatch(/PublicProjectLedgerItem/u);
    expect(projectsLazyRouteSource).toMatch(/errorComponent/u);
    expect(projectsLazyRouteSource).toMatch(/createLazyFileRoute\("\/projects"\)/u);
    expect(projectsLazyRouteSource).toMatch(/Projects/u);
    expect(projectsLazyRouteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(projectsLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(projectsLazyRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    expect(projectsLazyRouteSource).toMatch(/renderLink/u);
    expect(projectsLazyRouteSource).toMatch(/Open repository/u);

    expect(blogRouteSource).toMatch(/createFileRoute\("\/blog"\)/u);
    expect(blogRouteSource).toMatch(/publishedPostsQueryOptions\("blog"\)/u);
    expect(blogRouteSource).toMatch(/ensureQueryData/u);
    expect(blogRouteSource).not.toMatch(/PublicTransmissionListItem/u);
    expect(blogLazyRouteSource).toMatch(/errorComponent/u);
    expect(blogLazyRouteSource).toMatch(/createLazyFileRoute\("\/blog"\)/u);
    expect(blogLazyRouteSource).toMatch(/title="Blog"/u);
    expect(blogLazyRouteSource).toMatch(/PublicTransmissionListItem/u);
    expect(blogLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(blogLazyRouteSource).toMatch(/to="\/blog\/\$slug"/u);
    expect(blogLazyRouteSource).toMatch(/renderLink/u);

    expect(aboutRouteSource).toMatch(/createFileRoute\("\/about"\)/u);
    expect(aboutRouteSource).not.toMatch(/statusSnapshotQueryOptions/u);
    expect(aboutLazyRouteSource).toMatch(/createLazyFileRoute\("\/about"\)/u);
    expect(aboutLazyRouteSource).toMatch(/@unimatrix\/ui\/public/u);
    expect(aboutLazyRouteSource).toMatch(/About/u);

    expect(projectDetailRouteSource).toMatch(/createFileRoute\("\/projects_\/\$slug"\)/u);
    expect(projectDetailRouteSource).toMatch(/publishedPostQueryOptions\("project"/u);
    // A 404 (or a slug the shared schema rejects) has to reach the route's
    // not-found component rather than the error boundary.
    expect(projectDetailRouteSource).toMatch(/isMissingContentError/u);
    expect(projectDetailRouteSource).toMatch(/throw createProjectNotFoundError/u);
    expect(projectDetailRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(projectDetailLazyRouteSource).toMatch(/createLazyFileRoute\("\/projects_\/\$slug"\)/u);
    expect(projectDetailLazyRouteSource).toMatch(/notFoundComponent: ProjectNotFound/u);
    expect(projectDetailLazyRouteSource).toMatch(/LazyPublicMarkdown/u);
    expect(projectDetailLazyRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(projectDetailLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);

    expect(blogDetailRouteSource).toMatch(/createFileRoute\("\/blog_\/\$slug"\)/u);
    expect(blogDetailRouteSource).toMatch(/publishedPostQueryOptions\("blog"/u);
    expect(blogDetailRouteSource).toMatch(/isMissingContentError/u);
    expect(blogDetailRouteSource).toMatch(/throw createBlogNotFoundError/u);
    expect(blogDetailRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(blogDetailLazyRouteSource).toMatch(/createLazyFileRoute\("\/blog_\/\$slug"\)/u);
    expect(blogDetailLazyRouteSource).toMatch(/notFoundComponent: BlogNotFound/u);
    expect(blogDetailLazyRouteSource).toMatch(/LazyPublicMarkdown/u);
    expect(blogDetailLazyRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(blogDetailLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
  });
});
