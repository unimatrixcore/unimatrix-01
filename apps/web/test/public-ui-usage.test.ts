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

void test("@unimatrix/ui exports the intentionally small public-site surface", () => {
  const source = readRepositoryFile("packages/ui/src/index.ts");

  assert.match(source, /PublicAppFrame/u);
  assert.match(source, /PublicPageContainer/u);
  assert.match(source, /PublicSectionHeading/u);
  assert.match(source, /PublicContentParagraphs/u);
  assert.match(source, /PublicProjectCard/u);
  assert.match(source, /PublicPostListItem/u);
});

void test("apps/web consumes the shared public-site primitives instead of route-local copies", () => {
  const appShellSource = readRepositoryFile("apps/web/src/app/app-shell.tsx");
  const homeRouteSource = readRepositoryFile("apps/web/src/routes/index.tsx");
  const projectsRouteSource = readRepositoryFile("apps/web/src/routes/projects.tsx");
  const blogRouteSource = readRepositoryFile("apps/web/src/routes/blog.tsx");

  assert.match(appShellSource, /PublicAppFrame/u);
  assert.match(appShellSource, /PublicPageContainer/u);

  assert.match(homeRouteSource, /PublicSectionHeading/u);
  assert.match(homeRouteSource, /PublicContentParagraphs/u);
  assert.match(homeRouteSource, /PublicProjectCard/u);
  assert.match(homeRouteSource, /PublicPostListItem/u);

  assert.match(projectsRouteSource, /PublicSectionHeading/u);
  assert.match(projectsRouteSource, /PublicProjectCard/u);

  assert.match(blogRouteSource, /PublicSectionHeading/u);
  assert.match(blogRouteSource, /PublicPostListItem/u);
});
