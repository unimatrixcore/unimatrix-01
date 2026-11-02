#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tasks = new Set(["build", "lint", "typecheck", "test"]);
const smokeApps = new Set(["apps/web", "apps/cflop", "apps/status"]);
const lighthouseApps = new Set(["apps/web", "apps/cflop"]);

export function workspaceFromManifest(path, manifest) {
  if (typeof manifest.name !== "string" || !/^@unimatrix\/[a-z0-9-]+$/u.test(manifest.name)) {
    throw new Error(`Invalid workspace name in ${path}/package.json`);
  }
  const dependencies = new Set();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (
      !entries ||
      typeof entries !== "object" ||
      Array.isArray(entries) ||
      Object.values(entries).some((version) => typeof version !== "string")
    ) {
      throw new Error(`Invalid ${field} in ${path}/package.json`);
    }
    for (const name of Object.keys(entries)) dependencies.add(name);
  }
  return { name: manifest.name, path, dependencies: [...dependencies] };
}

export function discoverWorkspaces(repoRoot) {
  const directories = [];
  for (const parent of ["apps", "packages"]) {
    if (!existsSync(join(repoRoot, parent))) continue;
    for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(repoRoot, parent, entry.name, "package.json"))) {
        directories.push(`${parent}/${entry.name}`);
      }
    }
  }
  if (existsSync(join(repoRoot, "lab/package.json"))) directories.push("lab");
  const names = new Set();
  const workspaces = directories.sort().map((path) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, path, "package.json"), "utf8"));
    const workspace = workspaceFromManifest(path, manifest);
    if (names.has(manifest.name)) throw new Error(`Duplicate workspace name: ${manifest.name}`);
    names.add(manifest.name);
    return workspace;
  });
  if (!workspaces.length) throw new Error("No workspaces found; refusing an empty CI inventory");
  return workspaces;
}

function guidanceOnly(path) {
  return (
    path === "README.md" ||
    path === "AGENTS.md" ||
    ((path.startsWith("docs/") || path.startsWith(".agents/")) && path.endsWith(".md"))
  );
}

export function createCIPlan({ workspaces, changedPaths, fullReason }) {
  let full = Boolean(fullReason);
  let reason = fullReason;
  const selected = new Set();
  for (const path of changedPaths ?? []) {
    if (
      typeof path !== "string" ||
      !path ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      throw new Error("Invalid changed path in CI comparison");
    }
    const owners = workspaces.filter((candidate) => path.startsWith(`${candidate.path}/`));
    if (owners.length) for (const workspace of owners) selected.add(workspace.name);
    else if (!guidanceOnly(path)) {
      full = true;
      reason ??= `Repository-wide or unknown input changed: ${path}`;
    }
  }
  if (full) for (const workspace of workspaces) selected.add(workspace.name);
  else {
    let added;
    do {
      added = false;
      for (const workspace of workspaces) {
        if (
          !selected.has(workspace.name) &&
          workspace.dependencies.some((name) => selected.has(name))
        ) {
          selected.add(workspace.name);
          added = true;
        }
      }
    } while (added);
  }
  const packages = workspaces
    .filter((workspace) => selected.has(workspace.name))
    .map(({ name, path }) => ({ name, path }));
  return {
    version: 1,
    full,
    reason:
      reason ??
      (packages.length
        ? "Changed workspaces and their consumers"
        : "Guidance-only or empty change"),
    packages,
    browser: packages.some(({ path }) => smokeApps.has(path)),
    lighthouse: packages.map(({ path }) => path).filter((path) => lighthouseApps.has(path)),
    dotnet: packages.some(({ path }) => path === "packages/unimatrix-tv"),
  };
}

export function readChangedPaths(repoRoot, base, head) {
  if (!base || !head) return { fullReason: "Comparison base or head is unavailable" };
  if (
    ![base, head].every(
      (sha) => typeof sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha),
    )
  ) {
    throw new Error("CI comparison base and head must be complete commit SHAs");
  }
  try {
    for (const sha of [base, head]) {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: repoRoot,
        stdio: "ignore",
      });
    }
    execFileSync("git", ["merge-base", base, head], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    return { fullReason: "Comparison history is unavailable; running every workspace" };
  }
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(Boolean);
  return { changedPaths };
}

export function readCIPlan(repoRoot, path) {
  const plan = JSON.parse(readFileSync(path, "utf8"));
  const workspaces = discoverWorkspaces(repoRoot);
  if (
    plan?.version !== 1 ||
    typeof plan.full !== "boolean" ||
    typeof plan.reason !== "string" ||
    !Array.isArray(plan.packages)
  ) {
    throw new Error("Invalid CI plan header");
  }
  const seen = new Set();
  for (const selected of plan.packages) {
    if (
      !selected ||
      !workspaces.some(({ name, path }) => name === selected.name && path === selected.path) ||
      seen.has(selected.name)
    ) {
      throw new Error("CI plan contains an unknown or duplicate workspace");
    }
    seen.add(selected.name);
  }
  if (plan.full && seen.size !== workspaces.length)
    throw new Error("Full CI plan omits workspaces");
  const derived = createCIPlan({
    workspaces,
    changedPaths: plan.packages.map(({ path }) => `${path}/package.json`),
  });
  if (derived.packages.length !== plan.packages.length)
    throw new Error("CI plan omits workspace consumers");
  if (
    plan.browser !== derived.browser ||
    plan.dotnet !== derived.dotnet ||
    JSON.stringify(plan.lighthouse) !== JSON.stringify(derived.lighthouse)
  ) {
    throw new Error("CI plan setup flags do not match selected workspaces");
  }
  return plan;
}

export function runPlanTask(repoRoot, plan, task, execute = execFileSync) {
  if (!tasks.has(task)) throw new Error(`Unsupported CI task: ${task}`);
  if (!plan.packages.length) {
    console.log(`ci-plan: no affected workspaces for ${task}`);
    return;
  }
  execute(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      task,
      ...plan.packages.map(({ name }) => `--filter=${name}`),
      ...(task === "test" ? ["--concurrency=2"] : []),
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );
}

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (
      !["--output", "--plan", "--event", "--base", "--head"].includes(key) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith("--") ||
      Object.hasOwn(options, key)
    ) {
      throw new Error(`Invalid CI planner argument: ${key}`);
    }
    options[key] = argv[index + 1];
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (argv[0] === "run") {
    const task = argv[1];
    const options = argumentsFor(argv.slice(2));
    if (Object.keys(options).some((key) => key !== "--plan") || !options["--plan"])
      throw new Error("CI task requires --plan only");
    runPlanTask(root, readCIPlan(root, options["--plan"]), task);
    return;
  }
  const options = argumentsFor(argv);
  if (options["--plan"]) throw new Error("Use --output when creating a CI plan");
  const output = options["--output"] ?? env.CI_PLAN_PATH;
  if (!output) throw new Error("CI planner requires --output or CI_PLAN_PATH");
  const event = options["--event"] ?? env.GITHUB_EVENT_NAME;
  if (!event) throw new Error("CI planner requires --event or GITHUB_EVENT_NAME");
  let comparison;
  if (event === "pull_request") {
    const payload = env.GITHUB_EVENT_PATH
      ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
      : {};
    comparison = readChangedPaths(
      root,
      options["--base"] ?? payload.pull_request?.base?.sha,
      options["--head"] ?? payload.pull_request?.head?.sha,
    );
  } else comparison = { fullReason: `${event} runs verify every workspace` };
  const plan = createCIPlan({ workspaces: discoverWorkspaces(root), ...comparison });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
  const outputs = {
    full: plan.full,
    has_tasks: plan.packages.length > 0,
    packages: JSON.stringify(plan.packages.map(({ name }) => name)),
    browser: plan.browser,
    lighthouse_web: plan.lighthouse.includes("apps/web"),
    lighthouse_cflop: plan.lighthouse.includes("apps/cflop"),
    dotnet: plan.dotnet,
  };
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(`ci-plan: ${plan.reason}`);
  console.log(
    `ci-plan: ${plan.packages.map(({ name }) => name).join(", ") || "no workspace tasks"}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`ci-plan: ${error.message}`);
    process.exitCode = 1;
  }
}
