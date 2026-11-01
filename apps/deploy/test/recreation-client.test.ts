import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRecreationCommand,
  createDokployRecreationClient,
  recreationComposeSchema,
} from "../src/dokploy/recreation-client.js";

const row = {
  composeId: "compose-api",
  name: "api",
  appName: "api-project",
  owner: "unimatrixcore",
  repository: "unimatrix-01",
  sourceType: "github",
  composeType: "docker-compose",
  composePath: "./infra/docker/api-compose.yaml",
  createEnvFile: true,
  serverId: null,
  mounts: [],
  command: null as string | null,
};
const command =
  "compose -p api-project --env-file infra/docker/.env -f ./infra/docker/api-compose.yaml up -d --build --remove-orphans --force-recreate";

void test("command projection preserves observed CLI flags and strips arbitrary command/env contents", () => {
  const inspected = recreationComposeSchema.parse({
    ...row,
    env: "SECRET=private",
    command: "private-command",
  });
  assert.equal(inspected.policy, "foreign-command");
  assert.doesNotMatch(JSON.stringify(inspected), /private|SECRET/);
  assert.equal(canonicalRecreationCommand(inspected), command);
  assert.equal(
    canonicalRecreationCommand({ ...inspected, createEnvFile: false }),
    "compose -p api-project -f ./infra/docker/api-compose.yaml up -d --build --remove-orphans --force-recreate",
  );
  assert.equal(recreationComposeSchema.parse({ ...row, command }).policy, "enabled");
});

void test("unsupported command inputs cannot become shell arguments", () => {
  for (const patch of [
    { appName: "bad;host-command" },
    { composePath: "../outside.yaml" },
    { composePath: "infra/docker/a b-compose.yaml" },
    { composeType: "stack" },
    { serverId: "remote" },
    { mountCount: 1 },
  ]) {
    assert.equal(
      canonicalRecreationCommand({ ...recreationComposeSchema.parse(row), ...patch }),
      null,
    );
  }
  assert.equal(recreationComposeSchema.parse({ ...row, mounts: [{}] }).policy, "unsupported");
});

void test("enabling writes only command, discards mutation body and verifies readback", async () => {
  let current = { ...row };
  const calls: string[] = [];
  const success = new Response("private-updated-row-with-env");
  const client = createDokployRecreationClient({
    baseUrl: "http://dokploy",
    apiKey: "test",
    fetch: (url, init) => {
      assert.ok(url instanceof URL);
      calls.push(`${init?.method} ${url.pathname}`);
      if (init?.method === "POST") {
        assert.equal(typeof init.body, "string");
        assert.ok(typeof init.body === "string");
        assert.deepEqual(JSON.parse(init.body), { composeId: row.composeId, command });
        current = { ...current, command };
        return Promise.resolve(success);
      }
      return Promise.resolve(Response.json({ ...current, env: "private" }));
    },
  });
  assert.equal(await client.enable(await client.inspect(row.composeId)), "applied");
  assert.equal(success.bodyUsed, false);
  assert.equal(await client.enable(await client.inspect(row.composeId)), "already-enabled");
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 1);
});

void test("foreign commands, source ownership and changed inputs refuse before writing", async () => {
  for (const patch of [
    { command: "private-custom" },
    { owner: "foreign" },
    { sourceType: "raw" },
    { mounts: [{}] },
  ]) {
    let posts = 0;
    const client = createDokployRecreationClient({
      baseUrl: "http://dokploy",
      apiKey: "test",
      fetch: (_url, init) => {
        if (init?.method === "POST") posts++;
        return Promise.resolve(Response.json({ ...row, ...patch }));
      },
    });
    assert.equal(await client.enable(await client.inspect(row.composeId)), "refused");
    assert.equal(posts, 0);
  }
  const client = createDokployRecreationClient({
    baseUrl: "http://dokploy",
    apiKey: "test",
    fetch: () => Promise.resolve(Response.json({ ...row, appName: "changed-project" })),
  });
  assert.equal(await client.enable(recreationComposeSchema.parse(row)), "refused");
});

void test("uncertain writes and failed readbacks never retry or report applied", async () => {
  for (const mode of ["write-unknown", "read-error", "mismatch"]) {
    let wrote = false;
    let posts = 0;
    const client = createDokployRecreationClient({
      baseUrl: "http://dokploy",
      apiKey: "test",
      fetch: (_url, init) => {
        if (init?.method === "POST") {
          wrote = true;
          posts++;
          return mode === "write-unknown"
            ? Promise.reject(new Error("private"))
            : Promise.resolve(new Response("private"));
        }
        if (wrote && mode === "read-error") return Promise.reject(new Error("private"));
        return Promise.resolve(Response.json(row));
      },
    });
    assert.equal(
      await client.enable(await client.inspect(row.composeId)),
      mode === "mismatch" ? "verification-failed" : "write-status-unknown",
    );
    assert.equal(posts, 1);
  }
});

void test("a recreation-policy change between preflight and write is refused", async () => {
  let posts = 0;
  const client = createDokployRecreationClient({
    baseUrl: "http://dokploy",
    apiKey: "test",
    fetch: (_url, init) => {
      if (init?.method === "POST") posts++;
      return Promise.resolve(Response.json(row));
    },
  });
  assert.equal(await client.enable(recreationComposeSchema.parse({ ...row, command })), "refused");
  assert.equal(posts, 0);
});
