import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function required(env, name) {
  if (!env[name]) throw new Error(`Missing ${name}.`);
  return env[name];
}

function reportingUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("DEPLOY_REPORT_URL must be an HTTPS origin.");
  }
  return url.origin;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response.");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) throw new Error("Response limit exceeded.");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function deployCi({
  env = process.env,
  root = process.cwd(),
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const tag = required(env, "IMAGE_TAG");
  if (!/^[a-f0-9]{40}$/u.test(tag)) throw new Error("Invalid deployment commit.");
  if (env.DEPLOY_ATTEMPTS_ENABLED !== "true")
    throw new Error("Coordinated deployment execution must be enabled; no writes permitted.");
  const reportBase = reportingUrl(required(env, "DEPLOY_REPORT_URL"));
  const reportToken = required(env, "DEPLOY_REPORT_TOKEN");
  const base = required(env, "DOKPLOY_URL");
  const apiKey = required(env, "DOKPLOY_API_KEY");
  const headers = {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": required(env, "CF_ACCESS_CLIENT_ID"),
    "CF-Access-Client-Secret": required(env, "CF_ACCESS_CLIENT_SECRET"),
  };
  const apps = readdirSync(resolve(root, "infra/docker"))
    .filter((name) => name.endsWith("-compose.yaml"))
    .map((name) => name.slice(0, -13))
    .sort();
  if (!apps.length) throw new Error("No compose apps found.");
  const publications = new Map();
  {
    required(env, "GITHUB_REPOSITORY");
    required(env, "GITHUB_RUN_ID");
    required(env, "GITHUB_RUN_ATTEMPT");
    for (const app of apps) {
      let publication;
      try {
        publication = JSON.parse(readFileSync(resolve(root, "publication", `${app}.json`), "utf8"));
      } catch {
        throw new Error(`Missing publication for ${app}.`);
      }
      const image = publication?.image;
      if (
        publication?.app !== app ||
        image?.repository !== `ghcr.io/unimatrixcore/unimatrix-${app}` ||
        image.tag !== tag ||
        image.commit !== tag ||
        image.platform !== "linux/amd64" ||
        image.digestKind !== "manifest" ||
        !/^sha256:[a-f0-9]{64}$/u.test(image.digest ?? "")
      )
        throw new Error(`Invalid publication for ${app}.`);
      publications.set(app, image);
    }
  }
  async function call(path, body, reporting = false) {
    let response;
    try {
      response = await fetchImpl(`${reporting ? reportBase : base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...headers,
          ...(reporting ? { Authorization: `Bearer ${reportToken}` } : { "x-api-key": apiKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { result: "unknown", status: 0 };
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return {
        result: response.status >= 500 || response.status === 408 ? "unknown" : "rejected",
        status: response.status,
      };
    }
    return { result: "acknowledged", status: 200, response };
  }
  async function reserve(body) {
    for (let retry = 0; retry < 3; retry++) {
      const path = "/deployment/attempts/intent";
      const result = await call(path, body, true);
      if (result.result === "acknowledged") {
        try {
          const record = await boundedJson(result.response);
          return record;
        } catch {
          /* Retry only idempotent reporting. */
        }
      } else if (result.status >= 400 && result.status < 500 && result.status !== 429) break;
    }
    throw new Error("Durable deployment report unavailable.");
  }
  const projectResult = await call("/api/project.all");
  if (projectResult.result !== "acknowledged") throw new Error("Dokploy project discovery failed.");
  let projects;
  try {
    projects = await boundedJson(projectResult.response);
  } catch {
    throw new Error("Dokploy project discovery failed.");
  }
  if (!Array.isArray(projects)) throw new Error("Invalid project inventory.");
  const mappings = new Map();
  const failures = [];
  for (const app of apps) {
    const matches = projects.flatMap((project) =>
      (project.environments ?? []).flatMap((environment) =>
        (environment.compose ?? [])
          .filter((compose) => compose.name === app)
          .map((compose) => ({ project: project.projectId, compose: compose.composeId })),
      ),
    );
    if (
      matches.length !== 1 ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(matches[0]?.project ?? "") ||
      !/^[A-Za-z0-9_-]{1,256}$/u.test(matches[0]?.compose ?? "")
    )
      failures.push(`${app}: unique compose mapping unavailable`);
    else mappings.set(app, matches[0]);
  }
  // Reserve every app before starting execution; CI and rollback share these durable claims.
  const intents = new Map();
  {
    if (failures.length)
      throw new Error("Compose mapping incomplete; no deployment writes permitted.");
    for (const app of apps) {
      const request = {
        repository: env.GITHUB_REPOSITORY,
        runId: env.GITHUB_RUN_ID,
        runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
        app,
        trigger: "ci",
        image: publications.get(app),
      };
      const intent = await reserve(request);
      if (
        typeof intent.id !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          intent.id,
        ) ||
        ["repository", "runId", "runAttempt", "app", "trigger"].some(
          (key) => intent[key] !== request[key],
        ) ||
        ["repository", "tag", "commit", "platform", "digestKind", "digest"].some(
          (key) => intent.image?.[key] !== request.image[key],
        )
      )
        throw new Error("Invalid durable intent acknowledgement.");
      if (intent.tagWrite !== null || intent.queue !== null)
        throw new Error("Existing attempt has mutation results; refusing mutation replay.");
      intents.set(app, intent);
    }
  }
  let queued = 0;
  const executionOrder = [...mappings].sort(([left], [right]) =>
    left === "deploy" ? 1 : right === "deploy" ? -1 : left.localeCompare(right),
  );
  for (const [app, mapping] of executionOrder) {
    if (app === "web") {
      const result = await call(
        `/api/domain.byComposeId?composeId=${encodeURIComponent(mapping.compose)}`,
      );
      let domains;
      try {
        domains = result.response ? await boundedJson(result.response) : null;
      } catch {
        domains = null;
      }
      if (
        !Array.isArray(domains) ||
        domains.some((domain) => domain.host === "status.unimatrix-01.dev")
      ) {
        failures.push("web: held until status hostname moves to the status service");
        continue;
      }
    }
    const intent = intents.get(app);
    const result = await call("/deployment/execute", { app, attemptId: intent.id }, true);
    // Execution can already have mutated Dokploy when its response is lost. Never replay it.
    if (result.result !== "acknowledged") {
      failures.push(`${app}: execution rejected or its result is unknown`);
      continue;
    }
    let record;
    try {
      record = await boundedJson(result.response);
    } catch {
      failures.push(`${app}: execution result is unknown`);
      continue;
    }
    if (
      record.id !== intent.id ||
      ["repository", "runId", "runAttempt", "app", "trigger"].some(
        (key) => record[key] !== intent[key],
      ) ||
      ["repository", "tag", "commit", "platform", "digestKind", "digest"].some(
        (key) => record.image?.[key] !== intent.image[key],
      ) ||
      record.tagWrite !== "acknowledged" ||
      record.queue !== "acknowledged"
    ) {
      failures.push(`${app}: execution was not acknowledged for the intended image`);
      continue;
    }
    queued++;
    log(`${app}: deployment queued`);
  }
  if (failures.length) throw new Error(failures.join("; "));
  log(`${queued} stack(s) queued at ${tag}. Queued is not applied.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployCi();
  } catch {
    console.error(
      "::error::Deployment did not complete; inspect request/attempt state before retrying mutations.",
    );
    process.exitCode = 1;
  }
}
