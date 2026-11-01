import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runReconcileCli, type ReconcileCliDeps } from "../src/cli/reconcile.js";
import type { DokployCreationCompose } from "../src/dokploy/creation-client.js";

function fixture() {
  const lines: string[] = [];
  let created = false;
  let configured = false;
  let description = "";
  const row = (): DokployCreationCompose => ({
    composeId: "new-id",
    name: "web",
    description,
    environmentId: "env",
    composeType: "docker-compose",
    sourceType: configured ? "github" : "raw",
    owner: configured ? "unimatrixcore" : null,
    repository: configured ? "unimatrix-01" : null,
    branch: configured ? "main" : null,
    autoDeploy: !configured,
    composePath: configured ? "infra/docker/web-compose.yaml" : "./docker-compose.yml",
    githubId: configured ? "provider" : null,
  });
  const deps: ReconcileCliDeps = {
    client: {
      getProjects: () =>
        Promise.resolve([
          {
            projectId: "project",
            name: "project",
            environments: [
              {
                environmentId: "env",
                name: "production",
                compose: created
                  ? [{ composeId: "new-id", name: "web", composeStatus: "idle" }]
                  : [],
              },
            ],
          },
        ]),
      getCompose: () => Promise.reject(new Error("unused")),
      getContainers: () => Promise.resolve([]),
      getDokployVersion: () => Promise.resolve("test"),
      updateComposeSettings: () => Promise.reject(new Error("unused")),
    },
    desired: [
      {
        appDir: "web",
        packageName: "@unimatrix/web",
        kind: "static-spa",
        composePath: "infra/docker/web-compose.yaml",
        image: "ghcr.io/unimatrixcore/unimatrix-web",
        containerPort: 8080,
        env: [],
        buildArgNames: [],
        publicStatus: true,
        healthProbe: { url: "http://web:8080/" },
      },
    ],
    write: (line) => lines.push(line),
    secretEnv: null,
    creation: {
      config: { environmentId: "env", githubId: "provider" },
      store: { reserve: () => true },
      client: {
        createCompose: (input) => {
          created = true;
          description = input.description;
          return Promise.resolve();
        },
        configureCompose: () => {
          configured = true;
          return Promise.resolve();
        },
        getCompose: () => Promise.resolve(row()),
      },
    },
  };
  return { deps, lines };
}

void test("creation CLI returns success only after source verification", async () => {
  const { deps, lines } = fixture();
  assert.equal(await runReconcileCli(["create", "web"], deps), 0);
  assert.deepEqual(lines, ["web: CREATED"]);
  assert.equal(await runReconcileCli(["create", "web"], deps), 2);
  assert.equal(lines.at(-1), "web: NOT-MISSING");
});

void test("real creation CLI loads invoke-time IDs and persists its reservation across processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-create-cli-"));
  let row: Record<string, unknown> | undefined;
  let creates = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/project.all") {
      response.end(
        JSON.stringify([
          {
            projectId: "project",
            name: "project",
            environments: [
              {
                environmentId: "target-env",
                name: "production",
                compose:
                  row === undefined
                    ? []
                    : [
                        {
                          composeId: "created-id",
                          name: "web",
                          composeStatus: "idle",
                        },
                      ],
              },
            ],
          },
        ]),
      );
      return;
    }
    if (request.url?.startsWith("/api/compose.one?") === true) {
      response.end(JSON.stringify(row));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const input = JSON.parse(body) as Record<string, unknown>;
      if (request.url === "/api/compose.create") {
        creates += 1;
        row = {
          ...input,
          composeId: "created-id",
          owner: null,
          repository: null,
          branch: null,
          githubId: null,
          autoDeploy: true,
          composePath: "./docker-compose.yml",
        };
      } else if (request.url === "/api/compose.update") {
        row = { ...row, ...input };
      } else {
        response.statusCode = 404;
      }
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  const cli = fileURLToPath(new URL("../src/cli/reconcile.ts", import.meta.url));
  function run(
    argv: string[],
    ids: Record<string, string> = {},
    databasePath = join(directory, "deploy.sqlite"),
  ) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", cli, ...argv], {
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DOKPLOY_API_KEY: "test-key",
            DOKPLOY_BASE_URL: baseUrl,
            DEPLOY_DATABASE_PATH: databasePath,
            ...ids,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          resolve({ code, stdout, stderr });
        });
      },
    );
  }
  try {
    const missing = await run(["create", "web"], { DOKPLOY_ENVIRONMENT_ID: "target-env" });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /DOKPLOY_GITHUB_ID must be set/u);
    const ids = { DOKPLOY_ENVIRONMENT_ID: "target-env", DOKPLOY_GITHUB_ID: "target-provider" };
    const unavailableStore = await run(["create", "web"], ids, "/dev/null/deploy.sqlite");
    assert.equal(unavailableStore.code, 4);
    assert.equal(
      unavailableStore.stderr,
      "reconcile create: could not open creation reservations.\n",
    );
    const result = await run(["create", "web"], ids);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, "web: CREATED\n");
    assert.equal(row?.githubId, "target-provider");
    assert.equal(row?.environmentId, "target-env");
    assert.equal(row?.autoDeploy, false);
    row = undefined;
    const retry = await run(["create", "web"], ids);
    assert.equal(retry.code, 2, retry.stderr);
    assert.equal(retry.stdout, "web: ALREADY-ATTEMPTED\n");
    assert.equal(creates, 1);
    const report = await run(["report"]);
    assert.equal(report.code, 1, report.stderr);
    assert.equal(report.stderr, "");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("creation CLI refuses unconfigured creation and malformed invocation", async () => {
  const { deps, lines } = fixture();
  const unconfigured = { ...deps };
  delete unconfigured.creation;
  assert.equal(await runReconcileCli(["create", "web"], unconfigured), 2);
  assert.deepEqual(lines, ["REFUSED — service creation is not configured."]);
  assert.equal(await runReconcileCli(["create"], deps), 2);
  assert.equal(await runReconcileCli(["create", "web", "--force"], deps), 2);
});

void test("creation CLI preserves distinct failure exit codes", async () => {
  for (const failure of ["read", "store", "create", "configure", "verify"] as const) {
    const { deps, lines } = fixture();
    assert.ok(deps.creation);
    if (failure === "read")
      deps.client.getProjects = () => Promise.reject(new Error("unavailable"));
    if (failure === "store")
      deps.creation.store.reserve = () => {
        throw new Error("unavailable");
      };
    if (failure === "create")
      deps.creation.client.createCompose = () => Promise.reject(new Error("unknown"));
    if (failure === "configure")
      deps.creation.client.configureCompose = () => Promise.reject(new Error("unknown"));
    if (failure === "verify") deps.creation.client.configureCompose = () => Promise.resolve();
    const expected = failure === "read" || failure === "store" ? 4 : failure === "verify" ? 5 : 3;
    assert.equal(await runReconcileCli(["create", "web"], deps), expected);
    assert.equal(lines.length, 1);
  }
});
