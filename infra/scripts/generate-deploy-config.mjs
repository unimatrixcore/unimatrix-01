#!/usr/bin/env node
//
// Writes apps/<app>/Dockerfile and infra/docker/<app>-compose.yaml from each
// apps/<app>/deploy.config.ts, plus reconciliation and declaration manifests
// from every app's config together. Two modes, one script, so they can never
// diverge:
//
//   (default) / --stage — writes the files that changed, then
//     `git add --` exactly the paths it wrote (never a glob — see below).
//   --check — compares in memory against what is already on disk, prints a
//     diff on mismatch, and writes nothing. This is the drift check
//     `check:deploy-config` runs in `pnpm check`/`pnpm verify`.
//
// Base images are not generated: each app's Dockerfile is read first, its
// external-image `FROM` lines are pulled out verbatim, and dockerfileFor()
// re-emits exactly those lines — see packages/deploy-config/AGENTS.md for
// why (a Dependabot nginx digest bump must never touch this config).
// nginx.conf is never touched either.
//
// Compose and desired-state output are both formatted through prettier's API
// before writing or comparing (prettier@3.9.6 resolves from here —
// measured), with the repo's own .prettierrc.json resolved once and spread
// into every format() call — its defaults alone (printWidth 80) disagree
// with `pnpm format:check` (printWidth 100) and would reject the output.
// Dockerfiles are unaffected: prettier has no Dockerfile parser.
//
// resolveConfig() takes a *file* path and searches upward from that file's
// directory, so it must be given a file inside the repo root rather than the
// root itself — handed a directory, it starts one level too high and finds
// the repo's config only when some ancestor happens to hold one. A worktree
// nested inside another checkout has such an ancestor and a CI
// checkout does not, which is why a missing config surfaced as generated
// output that differed between the two rather than as an error. Resolution
// failing is fatal here for the same reason: falling back to prettier's
// defaults silently reformats every generated file.
//
// Fails closed on zero apps/*/deploy.config.ts discovered, same convention
// as validate-deploy-config.mjs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as prettier from "prettier";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const appsDir = join(repoRoot, "apps");
const composeDir = join(repoRoot, "infra", "docker");
const desiredStatePath = join(appsDir, "deploy", "src", "reconcile", "desired-state.gen.ts");
const declarationsPath = join(appsDir, "deploy", "src", "declarations", "manifest.gen.ts");

const mode = process.argv.includes("--check") ? "check" : "stage";

const { dockerfileFor, composeFor, deployDesiredStateModule, deployDeclarationsModule } =
  await import(pathToFileURL(join(repoRoot, "packages", "deploy-config", "src", "index.ts")).href);

const prettierConfigPath = join(repoRoot, ".prettierrc.json");
const prettierConfig = await prettier.resolveConfig(prettierConfigPath);
if (prettierConfig === null) {
  console.error(`generate-deploy-config: no prettier config resolved from ${prettierConfigPath}.`);
  process.exit(1);
}

/**
 * Reads a file, returning `null` when it does not exist. Reading straight
 * through rather than testing `existsSync` first keeps this off the
 * check-then-read race CodeQL flags (`js/file-system-race`); a missing file
 * and one deleted between the two calls are the same case at every caller.
 */
function readFileIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The Dockerfile's own external-image `FROM` lines, read off the file
 * already on disk. `FROM base AS <stage>` is a local-stage reference the
 * generator always emits itself, so it is excluded here — exactly two
 * external `FROM` lines are expected (the base image, then the runtime
 * image), and a different count is a hard error rather than a guess.
 */
function readFromLines(app) {
  const dockerfilePath = join(appsDir, app, "Dockerfile");
  const dockerfile = readFileIfPresent(dockerfilePath);
  if (dockerfile === null) {
    throw new Error(
      `apps/${app}/Dockerfile does not exist yet, so there is nothing to read its base images ` +
        `from. Create the Dockerfile once by hand (or copy a sibling app's) before generating.`,
    );
  }

  const externalFromLines = dockerfile
    .split("\n")
    .filter((line) => /^FROM\s+\S/u.test(line) && !/^FROM\s+base\s+AS\s+/iu.test(line));

  if (externalFromLines.length !== 2) {
    throw new Error(
      `apps/${app}/Dockerfile has ${externalFromLines.length} external-image FROM line(s); ` +
        `expected exactly 2 (base, runtime).`,
    );
  }

  const [base, runtime] = externalFromLines;
  return { base, runtime };
}

/** A minimal line-based diff — dev-facing output only, not a patch format. */
function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`  - ${a[i]}`);
      i += 1;
    } else {
      out.push(`  + ${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) {
    out.push(`  - ${a[i]}`);
    i += 1;
  }
  while (j < b.length) {
    out.push(`  + ${b[j]}`);
    j += 1;
  }

  return out.join("\n");
}

function discoverApps() {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, "deploy.config.ts")),
    )
    .map((entry) => entry.name)
    .sort();
}

async function loadConfig(app) {
  const mod = await import(pathToFileURL(join(appsDir, app, "deploy.config.ts")).href);
  return mod.default;
}

async function renderApp(app, config) {
  const fromLines = readFromLines(app);

  const dockerfileContent = dockerfileFor(config, fromLines);
  const composeContent = await prettier.format(composeFor(config), {
    ...prettierConfig,
    filepath: join(composeDir, `${app}-compose.yaml`),
  });

  return [
    { path: join(appsDir, app, "Dockerfile"), content: dockerfileContent },
    { path: join(composeDir, `${app}-compose.yaml`), content: composeContent },
  ];
}

async function main() {
  if (mode === "stage") {
    // No shell — the quoted pathspec reaches git intact, and git's own
    // pathspec globbing matches `*` across `/`, so this covers every app.
    const dirty = execFileSync("git", ["diff", "--name-only", "--", "apps/*/deploy.config.ts"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    if (dirty.length > 0) {
      console.error(
        "generate-deploy-config: the following deploy.config.ts file(s) have unstaged changes:\n\n" +
          dirty
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n") +
          "\n\nStage or stash them before generating — otherwise the Dockerfile/compose output " +
          "just written would not match what is about to be committed.",
      );
      process.exit(1);
    }
  }

  const apps = discoverApps();
  if (apps.length === 0) {
    console.error(
      "generate-deploy-config: no apps/*/deploy.config.ts found — refusing to run vacuously.",
    );
    process.exit(1);
  }

  const configs = [];
  const written = [];
  let mismatches = 0;

  for (const app of apps) {
    const config = await loadConfig(app);
    configs.push(config);

    for (const { path, content } of await renderApp(app, config)) {
      // Read straight through rather than testing existsSync first: a missing
      // file and a file deleted between the two calls are the same case here,
      // and the check-then-read pair is a race CodeQL flags (js/file-system-race).
      const existing = readFileIfPresent(path);
      if (existing === content) continue;

      if (mode === "check") {
        mismatches += 1;
        console.log(`  DIFF  ${relative(repoRoot, path)}`);
        console.log(diffLines(existing ?? "", content));
      } else {
        writeFileSync(path, content);
        written.push(path);
      }
    }
  }

  for (const { path, source } of [
    { path: desiredStatePath, source: deployDesiredStateModule(configs) },
    { path: declarationsPath, source: deployDeclarationsModule(configs) },
  ]) {
    const content = await prettier.format(source, { ...prettierConfig, filepath: path });
    const existing = readFileIfPresent(path);

    if (existing !== content) {
      if (mode === "check") {
        mismatches += 1;
        console.log(`  DIFF  ${relative(repoRoot, path)}`);
        console.log(diffLines(existing ?? "", content));
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(path);
      }
    }
  }

  if (mode === "check") {
    if (mismatches > 0) {
      console.log(
        `\ngenerate-deploy-config --check: ${mismatches} file(s) out of date with their deploy.config.ts.`,
      );
      process.exit(1);
    }
    console.log(
      `generate-deploy-config --check: OK, ${apps.length} app(s) match their deploy.config.ts.`,
    );
    return;
  }

  if (written.length === 0) {
    console.log("generate-deploy-config: nothing to regenerate.");
    return;
  }

  execFileSync("git", ["add", "--", ...written.map((path) => relative(repoRoot, path))], {
    cwd: repoRoot,
  });
  console.log(`generate-deploy-config: wrote and staged ${written.length} file(s).`);
}

await main();
