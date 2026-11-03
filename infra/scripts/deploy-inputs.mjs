import { isDeepStrictEqual } from "node:util";

import { createCIPlan } from "./ci-plan.mjs";
import { deploymentLockfileInputs } from "./deploy-lockfile.mjs";

const validationWorkspaces = new Set([
  "@unimatrix/config-eslint",
  "@unimatrix/config-vitest",
  "@unimatrix/e2e-helpers",
]);

export function validationDependency(name, field) {
  return (
    field === "devDependencies" &&
    (validationWorkspaces.has(name) ||
      /^(?:eslint(?:$|-)|@eslint\/|eslint-plugin-|typescript-eslint$|vitest$|@vitest\/|@testing-library\/|@playwright\/|@axe-core\/|jsdom$)/u.test(
        name,
      ))
  );
}

export function deploymentWorkspace(workspace, manifest) {
  return {
    ...workspace,
    // Keep build tools and any validation package declared as a runtime or peer dependency.
    dependencies: workspace.dependencies.filter(
      (name) =>
        !validationDependency(name, "devDependencies") ||
        ["dependencies", "optionalDependencies", "peerDependencies"].some((field) =>
          Object.hasOwn(manifest[field] ?? {}, name),
        ),
    ),
  };
}

function validationOnly(path) {
  return (
    /(?:^|\/)(?:README|AGENTS)\.md$/u.test(path) ||
    ((path.startsWith("docs/") || path.startsWith(".agents/")) && path.endsWith(".md")) ||
    path.startsWith(".github/") ||
    /^infra\/scripts\/deploy-(?:ci|plan|inputs|lockfile)(?:\.test)?\.mjs$/u.test(path) ||
    /(?:^|\/)(?:eslint\.config\.[cm]?js|vitest\.config\.[cm]?[jt]s|playwright\.config\.[cm]?[jt]s)$/u.test(
      path,
    )
  );
}

function buildManifest(text) {
  const manifest = JSON.parse(text);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (!manifest[field]) continue;
    manifest[field] = Object.fromEntries(
      Object.entries(manifest[field]).filter(([name]) => !validationDependency(name, field)),
    );
    if (!Object.keys(manifest[field]).length) delete manifest[field];
  }
  if (manifest.scripts) {
    manifest.scripts = Object.fromEntries(
      Object.entries(manifest.scripts).filter(
        ([name]) => !/^(?:lint|test|check|verify|format|deps)(?::|$)/u.test(name),
      ),
    );
    if (!Object.keys(manifest.scripts).length) delete manifest.scripts;
  }
  return manifest;
}

export function createDeploymentComparison({ workspaces, changedPaths, before, after }) {
  const graph = workspaces;
  const paths = changedPaths.filter((path) => {
    if (path === "pnpm-lock.yaml" || validationOnly(path)) return false;
    if (
      path === "package.json" ||
      graph.some((workspace) => path === `${workspace.path}/package.json`)
    ) {
      try {
        return !isDeepStrictEqual(buildManifest(before(path)), buildManifest(after(path)));
      } catch {
        return true;
      }
    }
    return true;
  });
  if (changedPaths.includes("pnpm-lock.yaml")) {
    const oldLock = before("pnpm-lock.yaml");
    const newLock = after("pnpm-lock.yaml");
    const appPaths = new Set(
      graph.filter(({ path }) => path.startsWith("apps/")).map(({ path }) => path),
    );
    for (const path of appPaths) {
      try {
        if (
          isDeepStrictEqual(
            deploymentLockfileInputs(oldLock, [path], validationDependency),
            deploymentLockfileInputs(newLock, [path], validationDependency),
          )
        )
          continue;
      } catch {
        // Missing or unsupported evidence selects this app without discarding other apps' evidence.
      }
      paths.push(`${path}/package.json`);
    }
  }
  return createCIPlan({
    workspaces: graph,
    changedPaths: paths.map((path) => {
      const compose = /^infra\/docker\/([a-z][a-z0-9-]*)-compose\.yaml$/u.exec(path);
      return compose ? `apps/${compose[1]}/deploy.config.ts` : path;
    }),
  });
}
