import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createCIPlan, discoverWorkspaces, workspaceFromManifest } from "./ci-plan.mjs";

const sha = /^[a-f0-9]{40}$/u;
const appName = /^[a-z][a-z0-9-]{0,63}$/u;
const repository = "unimatrixcore/unimatrix-01";

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  );
}

export function deploymentIdentity(env) {
  const identity = {
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    commit: env.IMAGE_TAG,
  };
  if (
    identity.repository !== repository ||
    !/^[0-9]{1,24}$/u.test(identity.runId ?? "") ||
    !Number.isSafeInteger(identity.runAttempt) ||
    identity.runAttempt < 1 ||
    identity.runAttempt > 1_000_000 ||
    !sha.test(identity.commit ?? "")
  ) {
    throw new Error("Invalid deployment plan identity.");
  }
  return identity;
}

export function discoverDeployApps(root) {
  const apps = readdirSync(resolve(root, "infra/docker"))
    .filter((name) => name.endsWith("-compose.yaml"))
    .map((name) => name.slice(0, -13))
    .sort();
  if (
    !apps.length ||
    apps.some((app) => !appName.test(app) || !existsSync(resolve(root, "apps", app, "Dockerfile")))
  ) {
    throw new Error("Invalid deployment inventory.");
  }
  const dockerApps = readdirSync(resolve(root, "apps"))
    .filter((app) => existsSync(resolve(root, "apps", app, "Dockerfile")))
    .sort();
  if (!isDeepStrictEqual(apps, dockerApps)) throw new Error("Deployment inventory mismatch.");
  return apps;
}

export function validBaseline(value, app) {
  return (
    exactKeys(value, ["commit", "containerId", "observedAt", "image"]) &&
    sha.test(value.commit ?? "") &&
    /^[a-f0-9]{64}$/u.test(value.containerId ?? "") &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt >= 0 &&
    exactKeys(value.image, ["repository", "platform", "digestKind", "digest"]) &&
    value.image.repository === `ghcr.io/unimatrixcore/unimatrix-${app}` &&
    value.image.platform === "linux/amd64" &&
    value.image.digestKind === "manifest" &&
    /^sha256:[a-f0-9]{64}$/u.test(value.image.digest ?? "")
  );
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function historicalWorkspaces(root, commit) {
  const paths = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    "apps",
    "packages",
    "lab",
  ])
    .split("\0")
    .filter((path) => /^(?:(?:apps|packages)\/[^/]+|lab)\/package\.json$/u.test(path));
  const names = new Set();
  if (!paths.length) throw new Error("Historical workspace inventory unavailable.");
  return paths.map((path) => {
    const workspace = workspaceFromManifest(
      path.slice(0, -13),
      JSON.parse(git(root, ["show", `${commit}:${path}`])),
    );
    if (names.has(workspace.name)) throw new Error("Duplicate historical workspace.");
    names.add(workspace.name);
    return workspace;
  });
}

function guidanceOnly(path) {
  return (
    /(?:^|\/)(?:README|AGENTS)\.md$/u.test(path) ||
    ((path.startsWith("docs/") || path.startsWith(".agents/")) && path.endsWith(".md"))
  );
}

export function createDeploymentPlan({ root, env, baselines = new Map(), forceAll = false }) {
  const identity = deploymentIdentity(env);
  const workspaces = discoverWorkspaces(root);
  const comparisons = new Map();
  const apps = discoverDeployApps(root).map((app) => {
    const workspace = workspaces.find((entry) => entry.path === `apps/${app}`);
    if (!workspace) throw new Error("Deployable app has no workspace.");
    const baseline = baselines.get(app) ?? null;
    if (baseline !== null && !validBaseline(baseline, app))
      throw new Error("Invalid deployment baseline.");
    let deploy = true;
    let reason = forceAll ? "manual-publication" : "baseline-unavailable";
    if (!forceAll && baseline !== null) {
      if (!comparisons.has(baseline.commit)) {
        try {
          // Compare complete trees: rollbacks and divergent history must include both sides.
          const changed = git(root, [
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            baseline.commit,
            identity.commit,
            "--",
          ])
            .split("\0")
            .filter(Boolean)
            .filter((path) => !guidanceOnly(path));
          const graph = [...workspaces, ...historicalWorkspaces(root, baseline.commit)];
          const changedPaths = changed.map((path) => {
            const compose = /^infra\/docker\/([a-z][a-z0-9-]*)-compose\.yaml$/u.exec(path);
            return compose ? `apps/${compose[1]}/deploy.config.ts` : path;
          });
          comparisons.set(baseline.commit, createCIPlan({ workspaces: graph, changedPaths }));
        } catch {
          comparisons.set(baseline.commit, null);
        }
      }
      const comparison = comparisons.get(baseline.commit);
      if (comparison === null) reason = "history-unavailable";
      else {
        deploy = comparison.packages.some((entry) => entry.name === workspace.name);
        reason = deploy ? "inputs-changed" : "inputs-unchanged";
      }
    }
    return { app, deploy, reason, baseline };
  });
  return { version: 1, ...identity, forceAll, apps };
}

export function readDeploymentPlan(root, env) {
  if (!env.DEPLOY_PLAN_PATH) throw new Error("Missing DEPLOY_PLAN_PATH.");
  const plan = JSON.parse(readFileSync(resolve(root, env.DEPLOY_PLAN_PATH), "utf8"));
  const identity = deploymentIdentity(env);
  const apps = discoverDeployApps(root);
  if (
    !exactKeys(plan, ["version", ...Object.keys(identity), "forceAll", "apps"]) ||
    plan.version !== 1 ||
    typeof plan.forceAll !== "boolean" ||
    Object.keys(identity).some((key) => identity[key] !== plan[key]) ||
    !Array.isArray(plan.apps) ||
    !isDeepStrictEqual(
      plan.apps.map((entry) => entry?.app),
      apps,
    ) ||
    plan.apps.some(
      (entry) =>
        !exactKeys(entry, ["app", "deploy", "reason", "baseline"]) ||
        typeof entry.deploy !== "boolean" ||
        typeof entry.reason !== "string" ||
        (entry.baseline !== null && !validBaseline(entry.baseline, entry.app)),
    )
  ) {
    throw new Error("Invalid deployment plan.");
  }
  const expected = createDeploymentPlan({
    root,
    env,
    baselines: new Map(plan.apps.map((entry) => [entry.app, entry.baseline])),
    forceAll: plan.forceAll,
  });
  if (!isDeepStrictEqual(plan, expected))
    throw new Error("Deployment plan selection does not match its inputs.");
  return plan;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing baseline response.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) throw new Error("Baseline response limit exceeded.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function readDeploymentBaselines(env, fetchImpl = fetch, now = Date.now) {
  const url = new URL(env.DEPLOY_REPORT_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    ["DEPLOY_REPORT_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"].some(
      (key) => !env[key],
    )
  ) {
    throw new Error("Missing or invalid deployment baseline configuration.");
  }
  const response = await fetchImpl(`${url.origin}/deployment/baselines`, {
    headers: {
      Authorization: `Bearer ${env.DEPLOY_REPORT_TOKEN}`,
      "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Deployment baselines unavailable.");
  }
  const snapshot = await boundedJson(response);
  const checkedAt = now();
  if (
    !exactKeys(snapshot, ["checkedAt", "apps"]) ||
    !Number.isSafeInteger(snapshot.checkedAt) ||
    snapshot.checkedAt < 0 ||
    snapshot.checkedAt > checkedAt ||
    checkedAt - snapshot.checkedAt >= 30_000 ||
    !Array.isArray(snapshot.apps) ||
    snapshot.apps.length > 100
  )
    throw new Error("Invalid deployment baselines.");
  const result = new Map();
  for (const entry of snapshot.apps) {
    if (
      !exactKeys(entry, ["app", "baseline"]) ||
      !appName.test(entry.app ?? "") ||
      result.has(entry.app) ||
      (entry.baseline !== null &&
        (!validBaseline(entry.baseline, entry.app) ||
          entry.baseline.observedAt > snapshot.checkedAt ||
          checkedAt - entry.baseline.observedAt >= 30_000))
    ) {
      throw new Error("Invalid deployment baseline.");
    }
    result.set(entry.app, entry.baseline);
  }
  return result;
}

export async function verifySkippedBaselines(plan, env, fetchImpl = fetch) {
  const skipped = plan.apps.filter((entry) => !entry.deploy);
  if (!skipped.length) return;
  let current;
  try {
    current = await readDeploymentBaselines(env, fetchImpl);
  } catch {
    throw new Error("Skipped services could not be revalidated; no deployment writes permitted.");
  }
  for (const { app, baseline } of skipped) {
    const observed = current.get(app);
    if (
      !observed ||
      baseline.commit !== observed.commit ||
      baseline.containerId !== observed.containerId ||
      !isDeepStrictEqual(baseline.image, observed.image)
    ) {
      throw new Error("A skipped service changed after planning; no deployment writes permitted.");
    }
  }
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  root = process.cwd(),
  fetchImpl = fetch,
) {
  if (argv[0] === "select" && argv.length === 2) {
    const plan = readDeploymentPlan(root, env);
    const entry = plan.apps.find(({ app }) => app === argv[1]);
    if (!entry) throw new Error("Unknown deployment app.");
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `selected=${entry.deploy}\n`);
    return;
  }
  if (argv.length || !env.DEPLOY_PLAN_PATH)
    throw new Error("Deployment planner requires DEPLOY_PLAN_PATH.");
  if (!["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME))
    throw new Error("Unsupported deployment event.");
  const forceAll = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  let baselines = new Map();
  if (!forceAll) {
    // An older deploy service has no baseline route; the bootstrap release must include it.
    try {
      baselines = await readDeploymentBaselines(env, fetchImpl);
    } catch {
      console.log("Deployment baselines unavailable; selecting services conservatively.");
    }
  }
  const plan = createDeploymentPlan({ root, env, baselines, forceAll });
  writeFileSync(resolve(root, env.DEPLOY_PLAN_PATH), `${JSON.stringify(plan, null, 2)}\n`);
  const selected = plan.apps.filter((entry) => entry.deploy).map((entry) => entry.app);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `has_apps=${selected.length > 0}\n`);
  for (const entry of plan.apps)
    console.log(`${entry.app}: ${entry.deploy ? "deploy" : "retain"} (${entry.reason})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("::error::Deployment planning failed.");
    process.exitCode = 1;
  });
}
