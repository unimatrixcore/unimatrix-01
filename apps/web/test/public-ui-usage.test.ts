import { existsSync, readFileSync } from "node:fs";
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

describe("public UI package usage", () => {
  it("@unimatrix/ui is the canonical shared shadcn package surface", () => {
    const source = readRepositoryFile("packages/ui/src/index.ts");
    const uiBarrelSource = readRepositoryFile("packages/ui/src/components/ui/index.ts");

    expect(source).toMatch(/components\/ui\/index/u);
    expect(source).toMatch(/PublicMarkdown/u);
    expect(source).toMatch(/cn/u);
    expect(uiBarrelSource).toMatch(/accordion/u);
    expect(uiBarrelSource).toMatch(/dialog/u);
    expect(uiBarrelSource).toMatch(/sidebar/u);
    expect(source).not.toMatch(/PublicAppFrame/u);
    expect(source).not.toMatch(/PublicPageContainer/u);
    expect(source).not.toMatch(/PublicSectionHeading/u);
    expect(source).not.toMatch(/PublicContentParagraphs/u);
    expect(source).not.toMatch(/PublicProjectCard/u);
    expect(source).not.toMatch(/PublicPostListItem/u);
  });

  it("packages/ui owns the canonical shadcn config and shared stylesheet export", () => {
    expect(existsSync(join(repositoryRoot, "packages/ui/components.json"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "apps/web/components.json"))).toBe(false);

    const uiPackageJson = readRepositoryFile("packages/ui/package.json");
    const webStylesSource = readRepositoryFile("apps/web/src/styles.css");

    expect(uiPackageJson).toContain("\"./styles.css\"");
    expect(webStylesSource).toContain('@import "@unimatrix/ui/styles.css";');
    expect(webStylesSource).not.toContain('@import "shadcn/tailwind.css";');
    expect(webStylesSource).not.toContain('@import "@fontsource-variable/geist-mono";');
  });

  it("apps/web owns its public-site compositions while consuming shared ui primitives", () => {
    const publicSiteSource = readRepositoryFile(
      "apps/web/src/features/public-site/components.tsx",
    );

    expect(publicSiteSource).toMatch(/export interface PublicAppFrameNavigationItem/u);
    expect(publicSiteSource).toMatch(/PublicPageContainer/u);
    expect(publicSiteSource).toMatch(/PublicSectionHeading/u);
    expect(publicSiteSource).toMatch(/PublicProjectCard/u);
    expect(publicSiteSource).toMatch(/PublicPostListItem/u);
    expect(publicSiteSource).toContain('from "@unimatrix/ui"');
  });

  it("apps/web consumes shared primitives from @unimatrix/ui and public-site compositions from the app", () => {
    const appShellSource = readRepositoryFile("apps/web/src/app/app-shell.tsx");
    const homeRouteSource = readRepositoryFile("apps/web/src/routes/index.tsx");
    const projectsRouteSource = readRepositoryFile("apps/web/src/routes/projects.tsx");
    const blogRouteSource = readRepositoryFile("apps/web/src/routes/blog.tsx");
    const projectDetailRouteSource = readRepositoryFile(
      "apps/web/src/routes/projects_.$slug.tsx",
    );
    const blogDetailRouteSource = readRepositoryFile(
      "apps/web/src/routes/blog_.$slug.tsx",
    );

    expect(appShellSource).toMatch(/PublicAppFrame/u);
    expect(appShellSource).toMatch(/PublicPageContainer/u);
    expect(appShellSource).toMatch(/@\/features\/public-site\/components/u);
    expect(appShellSource).toMatch(/Route deck \/\/ live/u);
    expect(appShellSource).toMatch(/Safe GFM active/u);

    expect(homeRouteSource).toMatch(/PublicSectionHeading/u);
    expect(homeRouteSource).toMatch(/PublicMarkdown/u);
    expect(homeRouteSource).toMatch(/PublicProjectCard/u);
    expect(homeRouteSource).toMatch(/PublicPostListItem/u);
    expect(homeRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(homeRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(homeRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    const homeRouteRenderLinkCount = (homeRouteSource.match(/renderLink/gu) ?? [])
      .length;
    expect(homeRouteRenderLinkCount).toBeGreaterThanOrEqual(2);
    expect(homeRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
    expect(homeRouteSource).toMatch(/to="\/blog\/\$slug"/u);

    expect(projectsRouteSource).toMatch(/Projects archive/u);
    expect(projectsRouteSource).toMatch(/PublicProjectCard/u);
    expect(projectsRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(projectsRouteSource).toMatch(/to="\/projects\/\$slug"/u);
    expect(projectsRouteSource).toMatch(/renderLink/u);
    expect(projectsRouteSource).toMatch(/View repository/u);

    expect(blogRouteSource).toMatch(/Blog archive/u);
    expect(blogRouteSource).toMatch(/PublicPostListItem/u);
    expect(blogRouteSource).toMatch(/@\/features\/public-site\/components/u);
    expect(blogRouteSource).toMatch(/to="\/blog\/\$slug"/u);
    expect(blogRouteSource).toMatch(/renderLink/u);

    expect(projectDetailRouteSource).toMatch(
      /createFileRoute\("\/projects_\/\$slug"\)/u,
    );
    expect(projectDetailRouteSource).toMatch(/PublicMarkdown/u);
    expect(projectDetailRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(projectDetailRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
    expect(blogDetailRouteSource).toMatch(/createFileRoute\("\/blog_\/\$slug"\)/u);
    expect(blogDetailRouteSource).toMatch(/PublicMarkdown/u);
    expect(blogDetailRouteSource).toMatch(/renderPublicMarkdownInternalLink/u);
    expect(blogDetailRouteSource).not.toMatch(/splitMarkdownIntoParagraphs/u);
  });
});
