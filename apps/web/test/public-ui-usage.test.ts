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
    const publicExportLines = publicSource.match(/^export \{ .* \} from ".*";$/gmu) ?? [];
    const expectedPublicExports = {
      Badge: "./components/ui/badge.js",
      Button: "./components/ui/button.js",
      Card: "./components/ui/card.js",
      Separator: "./components/ui/separator.js",
      PublicMarkdown: "./components/public-markdown.js",
      cn: "./lib/utils.js",
    };

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

    expect(publicExportLines).toHaveLength(Object.keys(expectedPublicExports).length);
    for (const [exportName, exportPath] of Object.entries(expectedPublicExports)) {
      expect(publicSource).toContain(`export { ${exportName} } from "${exportPath}";`);
    }
    expect(publicSource).not.toMatch(/accordion/u);
    expect(publicSource).not.toMatch(/dialog/u);
    expect(publicSource).not.toMatch(/sidebar/u);
    expect(publicSource).not.toMatch(/sonner/u);
    expect(publicSource).not.toMatch(/vaul/u);
  });

  it("packages/ui owns the canonical shadcn config and shared stylesheet export", () => {
    expect(existsSync(join(repositoryRoot, "packages/ui/components.json"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "apps/web/components.json"))).toBe(false);

    const uiPackageJson = readRepositoryFile("packages/ui/package.json");
    const webStylesSource = readRepositoryFile("apps/web/src/styles.css");

    expect(uiPackageJson).toContain("\"./styles.css\"");
    expect(uiPackageJson).toContain("\"./public\"");
    expect(webStylesSource).toContain('@import "@unimatrix/ui/styles.css";');
    expect(webStylesSource).not.toContain('@import "shadcn/tailwind.css";');
    expect(webStylesSource).not.toContain('@import "@fontsource-variable/geist-mono";');
  });

  it("apps/web owns its public-site compositions while consuming shared ui primitives", () => {
    const publicSiteSource = readRepositoryFile(
      "apps/web/src/features/public-site/components.tsx",
    );

    expect(publicSiteSource).toMatch(/PublicPageContainer/u);
    expect(publicSiteSource).toMatch(/PublicSectionHeading/u);
    expect(publicSiteSource).toMatch(/PublicDecisionCard/u);
    expect(publicSiteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(publicSiteSource).toMatch(/PublicTransmissionListItem/u);
    expect(publicSiteSource).toMatch(/PublicMetadataStrip/u);
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
    const projectDetailRouteSource = readRepositoryFile(
      "apps/web/src/routes/projects_.$slug.tsx",
    );
    const projectDetailLazyRouteSource = readRepositoryFile(
      "apps/web/src/routes/projects_.$slug.lazy.tsx",
    );
    const blogDetailRouteSource = readRepositoryFile(
      "apps/web/src/routes/blog_.$slug.tsx",
    );
    const blogDetailLazyRouteSource = readRepositoryFile(
      "apps/web/src/routes/blog_.$slug.lazy.tsx",
    );

    expect(appShellSource).toMatch(/PublicPageContainer/u);
    expect(appShellSource).toMatch(/@\/features\/public-site\/components/u);
    expect(appShellSource).toMatch(/@unimatrix\/ui\/public/u);
    expect(appShellSource).toMatch(/Gwenny Phalan/u);
    expect(appShellSource).toMatch(/routeCode: "01"/u);
    expect(appShellSource).toMatch(/aria-label="Primary"/u);

    expect(lazyMarkdownSource).toMatch(/lazy\(/u);
    expect(lazyMarkdownSource).toMatch(/import\("@unimatrix\/ui\/public"\)/u);
    expect(lazyMarkdownSource).toMatch(/module\.PublicMarkdown/u);
    expect(lazyMarkdownSource).toMatch(/getDerivedStateFromError/u);
    expect(lazyMarkdownSource).toMatch(/Markdown content could not be loaded right now/u);

    expect(homeRouteSource).toMatch(/createFileRoute\("\/"\)/u);
    expect(homeRouteSource).toMatch(/loader/u);
    expect(homeRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(homeLazyRouteSource).toMatch(/createLazyFileRoute\("\/"\)/u);
    expect(homeLazyRouteSource).toMatch(/@unimatrix\/ui\/public/u);
    expect(homeLazyRouteSource).toMatch(/PublicSectionHeading/u);
    expect(homeLazyRouteSource).toMatch(/PublicContentParagraphs/u);
    expect(homeLazyRouteSource).toMatch(/LazyPublicMarkdown/u);
    expect(homeLazyRouteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(homeLazyRouteSource).toMatch(/PublicTransmissionListItem/u);
    expect(homeLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(homeLazyRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(homeLazyRouteSource).toMatch(/View all projects/u);
    expect(homeLazyRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    const homeRouteRenderLinkCount = (homeLazyRouteSource.match(/renderLink/gu) ?? []).length;
    expect(homeRouteRenderLinkCount).toBeGreaterThanOrEqual(2);
    expect(homeLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
    expect(homeLazyRouteSource).toMatch(/to="\/blog\/\$slug"/u);

    expect(projectsRouteSource).toMatch(/createFileRoute\("\/projects"\)/u);
    expect(projectsRouteSource).not.toMatch(/PublicProjectLedgerItem/u);
    expect(projectsLazyRouteSource).toMatch(/createLazyFileRoute\("\/projects"\)/u);
    expect(projectsLazyRouteSource).toMatch(/Project list/u);
    expect(projectsLazyRouteSource).toMatch(/PublicProjectLedgerItem/u);
    expect(projectsLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(projectsLazyRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    expect(projectsLazyRouteSource).toMatch(/renderLink/u);
    expect(projectsLazyRouteSource).toMatch(/Open repository/u);

    expect(blogRouteSource).toMatch(/createFileRoute\("\/blog"\)/u);
    expect(blogRouteSource).not.toMatch(/PublicTransmissionListItem/u);
    expect(blogLazyRouteSource).toMatch(/createLazyFileRoute\("\/blog"\)/u);
    expect(blogLazyRouteSource).toMatch(/Writing archive/u);
    expect(blogLazyRouteSource).toMatch(/PublicTransmissionListItem/u);
    expect(blogLazyRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(blogLazyRouteSource).toMatch(/to="\/blog\/\$slug"/u);
    expect(blogLazyRouteSource).toMatch(/renderLink/u);

    expect(aboutRouteSource).toMatch(/createFileRoute\("\/about"\)/u);
    expect(aboutRouteSource).toMatch(/statusSnapshotQueryOptions/u);
    expect(aboutRouteSource).not.toMatch(/Query cache prefetch/u);
    expect(aboutLazyRouteSource).toMatch(/createLazyFileRoute\("\/about"\)/u);
    expect(aboutLazyRouteSource).toMatch(/@unimatrix\/ui\/public/u);
    expect(aboutLazyRouteSource).toMatch(/About and contact/u);

    expect(projectDetailRouteSource).toMatch(/createFileRoute\("\/projects_\/\$slug"\)/u);
    expect(projectDetailRouteSource).toMatch(/throw createProjectNotFoundError/u);
    expect(projectDetailRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(projectDetailLazyRouteSource).toMatch(
      /createLazyFileRoute\("\/projects_\/\$slug"\)/u,
    );
    expect(projectDetailLazyRouteSource).toMatch(/notFoundComponent: ProjectNotFound/u);
    expect(projectDetailLazyRouteSource).toMatch(/LazyPublicMarkdown/u);
    expect(projectDetailLazyRouteSource).toMatch(/PublicMetadataStrip/u);
    expect(projectDetailLazyRouteSource).toMatch(/PublicReadingFrame/u);
    expect(projectDetailLazyRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(projectDetailLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);

    expect(blogDetailRouteSource).toMatch(/createFileRoute\("\/blog_\/\$slug"\)/u);
    expect(blogDetailRouteSource).toMatch(/throw createBlogNotFoundError/u);
    expect(blogDetailRouteSource).not.toMatch(/PublicMarkdown/u);
    expect(blogDetailLazyRouteSource).toMatch(/createLazyFileRoute\("\/blog_\/\$slug"\)/u);
    expect(blogDetailLazyRouteSource).toMatch(/notFoundComponent: BlogNotFound/u);
    expect(blogDetailLazyRouteSource).toMatch(/LazyPublicMarkdown/u);
    expect(blogDetailLazyRouteSource).toMatch(/PublicMetadataStrip/u);
    expect(blogDetailLazyRouteSource).toMatch(/PublicReadingFrame/u);
    expect(blogDetailLazyRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(blogDetailLazyRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
  });
});
