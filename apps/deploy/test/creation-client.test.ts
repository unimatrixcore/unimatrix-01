import assert from "node:assert/strict";
import test from "node:test";

import { createDokployCreationClient } from "../src/dokploy/creation-client.js";
import { DokployClientError } from "../src/dokploy/transport.js";

const BASE_URL = "http://dokploy:3000";
const API_KEY = "creation-client-test-key";
const COMPOSE = {
  composeId: "compose-1",
  name: "api",
  description: "unimatrix-create:test",
  environmentId: "environment-1",
  composeType: "docker-compose",
  sourceType: "github",
  owner: "unimatrixcore",
  repository: "unimatrix-01",
  branch: "main",
  autoDeploy: false,
  composePath: "infra/docker/api-compose.yaml",
  githubId: "github-1",
};

void test("creation sends only the disconnected service fields and discards the success body", async () => {
  let sent: unknown;
  const response = new Response("success-body-must-stay-unread");
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: (url, init) => {
      assert.ok(url instanceof URL);
      assert.equal(url.href, `${BASE_URL}/api/compose.create`);
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init.headers).get("x-api-key"), API_KEY);
      assert.ok(typeof init.body === "string");
      sent = JSON.parse(init.body);
      return Promise.resolve(response);
    },
  });
  const widerInput = {
    name: "api",
    description: "unimatrix-create:test",
    environmentId: "environment-1",
    env: "SECRET=never-on-wire",
    autoDeploy: true,
    repository: "other-repository",
  };

  await client.createCompose(widerInput);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(sent, {
    name: "api",
    description: "unimatrix-create:test",
    environmentId: "environment-1",
    sourceType: "raw",
    composeType: "docker-compose",
  });
});

void test("source configuration pins repository policy and excludes wider input fields", async () => {
  let sent: unknown;
  const response = new Response("success-body-must-stay-unread");
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: (url, init) => {
      assert.ok(url instanceof URL);
      assert.equal(url.href, `${BASE_URL}/api/compose.update`);
      assert.equal(init?.method, "POST");
      assert.ok(typeof init.body === "string");
      sent = JSON.parse(init.body);
      return Promise.resolve(response);
    },
  });
  const widerInput = {
    composePath: "infra/docker/api-compose.yaml",
    githubId: "github-1",
    env: "SECRET=never-on-wire",
    owner: "foreign-owner",
    autoDeploy: true,
    branch: "foreign-branch",
    serverId: "foreign-server",
  };

  await client.configureCompose("compose-1", widerInput);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(sent, {
    composeId: "compose-1",
    sourceType: "github",
    composeType: "docker-compose",
    owner: "unimatrixcore",
    repository: "unimatrix-01",
    branch: "main",
    autoDeploy: false,
    githubId: "github-1",
    composePath: "infra/docker/api-compose.yaml",
  });
});

void test("creation readback strips env and provider credentials before returning", async () => {
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: (url, init) => {
      assert.ok(url instanceof URL);
      assert.equal(url.href, `${BASE_URL}/api/compose.one?composeId=compose-1`);
      assert.equal(init?.method, "GET");
      return Promise.resolve(
        Response.json({
          ...COMPOSE,
          env: "SECRET=hidden-value",
          github: { privateKey: "hidden-key" },
        }),
      );
    },
  });

  assert.deepEqual(await client.getCompose("compose-1"), COMPOSE);
});

void test("creation readback accepts the disconnected nullable source fields", async () => {
  const disconnected = {
    ...COMPOSE,
    sourceType: "raw",
    owner: null,
    repository: null,
    branch: null,
    githubId: null,
    autoDeploy: true,
  };
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () => Promise.resolve(Response.json(disconnected)),
  });

  assert.deepEqual(await client.getCompose("compose-1"), disconnected);
});

void test("invalid readback never includes the invalid source value or env in its error", async () => {
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () =>
      Promise.resolve(
        Response.json({ ...COMPOSE, autoDeploy: "hidden-value", env: "SECRET=hidden" }),
      ),
  });

  await assert.rejects(client.getCompose("compose-1"), (error: unknown) => {
    assert.ok(error instanceof DokployClientError);
    assert.equal(
      error.message,
      "Dokploy procedure compose.one returned a body that failed schema validation.",
    );
    assert.equal(error.status, 200);
    return true;
  });
});

void test("creation mutation errors retain only error code and field names", async () => {
  const client = createDokployCreationClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: () =>
      Promise.resolve(
        Response.json(
          {
            code: "BAD_REQUEST",
            message: "SECRET=hidden-value",
            data: { zodError: { fieldErrors: { environmentId: ["SECRET=hidden-value"] } } },
          },
          { status: 400 },
        ),
      ),
  });

  await assert.rejects(
    client.createCompose({
      name: "api",
      environmentId: "environment-1",
      description: "unimatrix-create:test",
    }),
    (error: unknown) => {
      assert.ok(error instanceof DokployClientError);
      assert.equal(
        error.message,
        "Dokploy procedure compose.create responded with status 400 (code: BAD_REQUEST) (fields: environmentId).",
      );
      assert.equal(error.status, 400);
      return true;
    },
  );
});
