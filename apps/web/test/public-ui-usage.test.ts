import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

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

void test("@unimatrix/ui is the canonical shared shadcn package surface", () => {
  const source = readRepositoryFile("packages/ui/src/index.ts");
  const uiBarrelSource = readRepositoryFile("packages/ui/src/components/ui/index.ts");

  assert.match(source, /components\/ui\/index/u);
  assert.match(source, /PublicMarkdown/u);
  assert.match(source, /cn/u);
  assert.match(uiBarrelSource, /accordion/u);
  assert.match(uiBarrelSource, /dialog/u);
  assert.match(uiBarrelSource, /sidebar/u);
  assert.doesNotMatch(source, /PublicAppFrame/u);
  assert.doesNotMatch(source, /PublicPageContainer/u);
  assert.doesNotMatch(source, /PublicSectionHeading/u);
  assert.doesNotMatch(source, /PublicContentParagraphs/u);
  assert.doesNotMatch(source, /PublicProjectCard/u);
  assert.doesNotMatch(source, /PublicPostListItem/u);
});

void test("packages/ui owns the canonical shadcn config and shared stylesheet export", () => {
  assert.ok(existsSync(join(repositoryRoot, "packages/ui/components.json")));
  assert.ok(!existsSync(join(repositoryRoot, "apps/web/components.json")));

  const uiPackageJson = readRepositoryFile("packages/ui/package.json");
  const webStylesSource = readRepositoryFile("apps/web/src/styles.css");

  assert.ok(uiPackageJson.includes("\"./styles.css\""));
  assert.ok(webStylesSource.includes('@import "@unimatrix/ui/styles.css";'));
  assert.ok(!webStylesSource.includes('@import "shadcn/tailwind.css";'));
  assert.ok(!webStylesSource.includes('@import "@fontsource-variable/geist-mono";'));
});

void test("apps/web owns its public-site compositions while consuming shared ui primitives", () => {
  const publicSiteSource = readRepositoryFile("apps/web/src/features/public-site/components.tsx");

  assert.match(publicSiteSource, /export interface PublicAppFrameNavigationItem/u);
  assert.match(publicSiteSource, /PublicPageContainer/u);
  assert.match(publicSiteSource, /PublicSectionHeading/u);
  assert.match(publicSiteSource, /PublicProjectCard/u);
  assert.match(publicSiteSource, /PublicPostListItem/u);
  assert.ok(publicSiteSource.includes('from "@unimatrix/ui"'));
});

void test("apps/web consumes shared primitives from @unimatrix/ui and public-site compositions from the app", () => {
  const appShellSource = readRepositoryFile("apps/web/src/app/app-shell.tsx");
  const homeRouteSource = readRepositoryFile("apps/web/src/routes/index.tsx");
  const projectsRouteSource = readRepositoryFile("apps/web/src/routes/projects.tsx");
  const blogRouteSource = readRepositoryFile("apps/web/src/routes/blog.tsx");
  const projectDetailRouteSource = readRepositoryFile("apps/web/src/routes/projects_.$slug.tsx");
  const blogDetailRouteSource = readRepositoryFile("apps/web/src/routes/blog_.$slug.tsx");

  assert.match(appShellSource, /PublicAppFrame/u);
  assert.match(appShellSource, /PublicPageContainer/u);
  assert.match(appShellSource, /@\/features\/public-site\/components/u);
  assert.match(appShellSource, /Route deck \/\/ live/u);
  assert.match(appShellSource, /Safe GFM active/u);

  assert.match(homeRouteSource, /PublicSectionHeading/u);
  assert.match(homeRouteSource, /PublicMarkdown/u);
  assert.match(homeRouteSource, /PublicProjectCard/u);
  assert.match(homeRouteSource, /PublicPostListItem/u);
  assert.match(homeRouteSource, /@\/features\/public-site\/components/u);
  assert.match(homeRouteSource, /renderPublicMarkdownInternalLink/u);
  assert.match(homeRouteSource, /to="\/projects\/\$slug"/u);
  const homeRouteRenderLinkCount = (homeRouteSource.match(/renderLink/gu) ?? []).length;
  assert.ok(
    homeRouteRenderLinkCount >= 2,
    `Expected at least 2 renderLink usages in index.tsx, got ${homeRouteRenderLinkCount}.`,
  );
  assert.doesNotMatch(homeRouteSource, /splitMarkdownIntoParagraphs/u);
  assert.match(homeRouteSource, /to="\/blog\/\$slug"/u);

  assert.match(projectsRouteSource, /Projects archive/u);
  assert.match(projectsRouteSource, /PublicProjectCard/u);
  assert.match(projectsRouteSource, /@\/features\/public-site\/components/u);
  assert.match(projectsRouteSource, /to="\/projects\/\$slug"/u);
  assert.match(projectsRouteSource, /renderLink/u);
  assert.match(projectsRouteSource, /View repository/u);

  assert.match(blogRouteSource, /Blog archive/u);
  assert.match(blogRouteSource, /PublicPostListItem/u);
  assert.match(blogRouteSource, /@\/features\/public-site\/components/u);
  assert.match(blogRouteSource, /to="\/blog\/\$slug"/u);
  assert.match(blogRouteSource, /renderLink/u);

  assert.match(projectDetailRouteSource, /createFileRoute\("\/projects_\/\$slug"\)/u);
  assert.match(projectDetailRouteSource, /PublicMarkdown/u);
  assert.match(projectDetailRouteSource, /renderPublicMarkdownInternalLink/u);
  assert.doesNotMatch(projectDetailRouteSource, /splitMarkdownIntoParagraphs/u);
  assert.match(blogDetailRouteSource, /createFileRoute\("\/blog_\/\$slug"\)/u);
  assert.match(blogDetailRouteSource, /PublicMarkdown/u);
  assert.match(blogDetailRouteSource, /renderPublicMarkdownInternalLink/u);
  assert.doesNotMatch(blogDetailRouteSource, /splitMarkdownIntoParagraphs/u);
});
