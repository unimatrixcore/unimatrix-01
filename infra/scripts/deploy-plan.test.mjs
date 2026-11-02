import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDeploymentPlan,
  readDeploymentPlan,
  readDeploymentBaselines,
  verifySkippedBaselines,
  main,
} from "./deploy-plan.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "deploy-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => writeFileSync(join(root, path), text);
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  for (const [path, manifest] of Object.entries({
    "apps/api": { name: "@unimatrix/api" },
    "apps/web": { name: "@unimatrix/web", dependencies: { "@unimatrix/ui": "workspace:*" } },
    "apps/admin": { name: "@unimatrix/admin", dependencies: { "@unimatrix/ui": "workspace:*" } },
    "packages/ui": { name: "@unimatrix/ui", dependencies: { "@unimatrix/helpers": "workspace:*" } },
    "packages/helpers": { name: "@unimatrix/helpers" },
    "packages/unused": { name: "@unimatrix/unused" },
  })) {
    mkdirSync(join(root, path), { recursive: true });
    write(`${path}/package.json`, JSON.stringify(manifest));
    write(`${path}/index.ts`, "initial\n");
    if (path.startsWith("apps/")) {
      const app = path.slice(5);
      write(`${path}/Dockerfile`, "FROM scratch\n");
      write(`infra/docker/${app}-compose.yaml`, "services: {}\n");
    }
  }
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Deployment fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = () => {
    git("add", ".");
    git("commit", "--allow-empty", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  const base = commit();
  const env = {
    GITHUB_REPOSITORY: "unimatrixcore/unimatrix-01",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    IMAGE_TAG: base,
    GITHUB_EVENT_NAME: "push",
    DEPLOY_PLAN_PATH: "deployment-plan.json",
    DEPLOY_REPORT_URL: "https://deploy.example",
    DEPLOY_REPORT_TOKEN: "private-token",
    CF_ACCESS_CLIENT_ID: "private-id",
    CF_ACCESS_CLIENT_SECRET: "private-secret",
  };
  const baselines = new Map(
    ["admin", "api", "web"].map((app) => [
      app,
      {
        commit: base,
        containerId: "a".repeat(64),
        observedAt: Date.now(),
        image: {
          repository: `ghcr.io/unimatrixcore/unimatrix-${app}`,
          platform: "linux/amd64",
          digestKind: "manifest",
          digest: `sha256:${"b".repeat(64)}`,
        },
      },
    ]),
  );
  const plan = () => createDeploymentPlan({ root, env, baselines });
  const change = (path, content = "changed\n") => {
    write(path, content);
    env.IMAGE_TAG = commit();
    return plan();
  };
  const save = (value = plan()) => write(env.DEPLOY_PLAN_PATH, JSON.stringify(value));
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://deploy.example/deployment/baselines");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer private-token");
    const checkedAt = Date.now();
    return Response.json({
      checkedAt,
      apps: [...baselines].map(([app, baseline]) => ({
        app,
        baseline: baseline && { ...baseline, observedAt: checkedAt },
      })),
    });
  };
  return { root, env, git, write, commit, base, plan, change, save, baselines, fetchImpl };
}
const selected = (plan) => plan.apps.filter((entry) => entry.deploy).map((entry) => entry.app);

test("automatic workspace graph selects app changes and transitive consumers", (t) => {
  const f = fixture(t);
  assert.deepEqual(selected(f.plan()), []);
  assert.deepEqual(selected(f.change("apps/api/index.ts")), ["api"]);
  assert.deepEqual(selected(f.change("packages/helpers/index.ts")), ["admin", "api", "web"]);
});

test("guidance and unrelated workspace changes retain images; runtime markdown selects its app", (t) => {
  const f = fixture(t);
  assert.deepEqual(selected(f.change("README.md")), []);
  assert.deepEqual(selected(f.change("apps/web/README.md")), []);
  assert.deepEqual(selected(f.change("packages/unused/index.ts")), []);
  assert.deepEqual(selected(f.change("apps/web/home.md")), ["web"]);
});

test("compose changes are service scoped and root/unknown build inputs are conservative", (t) => {
  const f = fixture(t);
  assert.deepEqual(selected(f.change("infra/docker/api-compose.yaml")), ["api"]);
  for (const path of ["pnpm-lock.yaml", ".dockerignore", "turbo.json", "new-input"]) {
    assert.deepEqual(selected(f.change(path)), ["admin", "api", "web"]);
  }
});

test("Dockerfile and server configuration changes select their service", (t) => {
  const f = fixture(t);
  assert.deepEqual(selected(f.change("apps/web/nginx.conf")), ["web"]);
  assert.deepEqual(selected(f.change("apps/api/Dockerfile")), ["api", "web"]);
});

test("per-service baselines catch canceled merges, partial releases and rollbacks", (t) => {
  const f = fixture(t);
  f.change("apps/api/index.ts");
  const intermediate = f.env.IMAGE_TAG;
  f.baselines.set("api", { ...f.baselines.get("api"), commit: intermediate });
  assert.deepEqual(selected(f.change("apps/web/index.ts")), ["web"]);
  f.baselines.set("api", { ...f.baselines.get("api"), commit: f.base });
  assert.deepEqual(selected(f.plan()), ["api", "web"]);
});

test("historical graph retains removed workspace dependencies and package renames", (t) => {
  const f = fixture(t);
  f.write("packages/ui/package.json", JSON.stringify({ name: "@unimatrix/renamed-ui" }));
  assert.deepEqual(selected(f.change("packages/helpers/index.ts")), ["admin", "web"]);
});

test("direct tree comparison includes a divergence's removed changes", (t) => {
  const f = fixture(t);
  f.change("apps/api/index.ts");
  f.baselines.set("api", { ...f.baselines.get("api"), commit: f.env.IMAGE_TAG });
  f.git("checkout", "-b", "other", f.base);
  assert.deepEqual(selected(f.change("apps/web/index.ts")), ["api", "web"]);
});

test("deleted and renamed files are automatically attributed on both sides", (t) => {
  const f = fixture(t);
  f.git("mv", "apps/api/index.ts", "apps/web/moved.ts");
  f.env.IMAGE_TAG = f.commit();
  assert.deepEqual(selected(f.plan()), ["api", "web"]);
});

test("missing provenance/history selects only the uncertain service", (t) => {
  const f = fixture(t);
  f.baselines.set("api", null);
  assert.deepEqual(selected(f.plan()), ["api"]);
  f.baselines.set("api", {
    ...f.baselines.get("web"),
    image: { ...f.baselines.get("web").image, repository: "ghcr.io/unimatrixcore/unimatrix-api" },
    commit: "f".repeat(40),
  });
  assert.deepEqual(selected(f.plan()), ["api"]);
  assert.equal(f.plan().apps.find(({ app }) => app === "api").reason, "history-unavailable");
});

test("plans validate run identity, full inventory, baseline structure and recomputed selection", (t) => {
  const f = fixture(t);
  const valid = f.plan();
  f.save(valid);
  assert.deepEqual(readDeploymentPlan(f.root, f.env), valid);
  for (const corrupt of [
    { commit: "e".repeat(40) },
    { runId: "other" },
    { apps: [] },
    { apps: valid.apps.map((entry) => ({ ...entry, deploy: true })) },
    { apps: valid.apps.map((entry) => ({ ...entry, baseline: null })) },
    {
      apps: valid.apps.map((entry) => ({
        ...entry,
        baseline: { ...entry.baseline, extra: "forbidden" },
      })),
    },
  ]) {
    f.save({ ...valid, ...corrupt });
    assert.throws(() => readDeploymentPlan(f.root, f.env), /deployment (?:plan|baseline)/iu);
  }
});

test("new services require publication without updating a dependency map", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "apps/new"));
  f.write("apps/new/package.json", JSON.stringify({ name: "@unimatrix/new" }));
  f.write("apps/new/Dockerfile", "FROM scratch");
  f.write("infra/docker/new-compose.yaml", "services: {}");
  f.env.IMAGE_TAG = f.commit();
  assert.deepEqual(selected(f.plan()), ["new"]);
});

test("baseline reads reject stale, ambiguous, malformed and redirected evidence", async (t) => {
  const f = fixture(t);
  assert.equal((await readDeploymentBaselines(f.env, f.fetchImpl)).size, 3);
  const snapshot = {
    checkedAt: Date.now(),
    apps: [...f.baselines].map(([app, baseline]) => ({ app, baseline })),
  };
  for (const corrupt of [
    { ...snapshot, checkedAt: Date.now() - 30_001 },
    { ...snapshot, checkedAt: Date.now() + 60_000 },
    { ...snapshot, apps: [...snapshot.apps, snapshot.apps[0]] },
    { ...snapshot, apps: [{ app: "api", baseline: { ...f.baselines.get("api"), observedAt: 0 } }] },
    { ...snapshot, apps: [{ app: "api", baseline: { ...f.baselines.get("web") } }] },
    { ...snapshot, credential: "must not propagate" },
  ])
    await assert.rejects(
      readDeploymentBaselines(f.env, async () => Response.json(corrupt)),
      /baseline/iu,
    );
  await assert.rejects(
    readDeploymentBaselines(f.env, async () => new Response("", { status: 302 })),
    /unavailable/u,
  );
  await assert.rejects(
    readDeploymentBaselines(f.env, async () => new Response("x".repeat(1_048_577))),
    /limit/u,
  );
});

test("skips require fresh matching immutable evidence after publication", async (t) => {
  const f = fixture(t);
  const plan = f.plan();
  await verifySkippedBaselines(plan, f.env, f.fetchImpl);
  f.baselines.set("api", { ...f.baselines.get("api"), commit: "f".repeat(40) });
  await assert.rejects(verifySkippedBaselines(plan, f.env, f.fetchImpl), /changed after planning/u);
  f.baselines.set("api", null);
  await assert.rejects(verifySkippedBaselines(plan, f.env, f.fetchImpl), /changed after planning/u);
  await assert.rejects(
    verifySkippedBaselines(plan, f.env, async () => {
      throw new Error("private");
    }),
    /could not be revalidated/u,
  );
});

test("CLI keeps manual publication full, bootstraps older services and emits empty-plan skips", async (t) => {
  const f = fixture(t);
  f.env.GITHUB_OUTPUT = join(f.root, "output");
  await main([], f.env, f.root, f.fetchImpl);
  assert.deepEqual(selected(readDeploymentPlan(f.root, f.env)), []);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /has_apps=false/u);
  await main(["select", "api"], f.env, f.root);
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), /selected=false/u);
  await main([], f.env, f.root, async () => new Response("", { status: 404 }));
  assert.deepEqual(selected(readDeploymentPlan(f.root, f.env)), ["admin", "api", "web"]);
  f.env.GITHUB_EVENT_NAME = "workflow_dispatch";
  await main([], f.env, f.root, () => assert.fail("manual must not read deployment service"));
  assert.deepEqual(selected(readDeploymentPlan(f.root, f.env)), ["admin", "api", "web"]);
});
