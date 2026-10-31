import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openServiceTokenStore } from "../src/service-tokens/store.js";

void test("deploy tokens persist only hashes, establish identity and update usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-tokens-"));
  const path = join(directory, "nested", "deploy.sqlite");
  let store = openServiceTokenStore(path);
  try {
    const issued = store.issue({ name: "api-reader", capability: "read" });
    assert.match(issued.token, /^udt_[A-Za-z0-9_-]{43}$/u);
    assert.equal(issued.record.lastUsedAt, null);
    assert.equal(issued.record.name, "api-reader");
    assert.equal(issued.record.capability, "read");
    assert.equal(issued.record.revokedAt, null);
    const raw = new Database(path);
    try {
      assert.deepEqual(raw.prepare("SELECT token_hash FROM deploy_service_tokens").get(), {
        token_hash: createHash("sha256").update(issued.token).digest("hex"),
      });
      assert.equal(raw.pragma("user_version", { simple: true }), 0);
    } finally {
      raw.close();
    }
    const authenticated = store.authenticate(issued.token);
    assert.equal(authenticated?.id, issued.record.id);
    assert.ok(authenticated?.lastUsedAt);
    assert.equal(JSON.stringify(store.list()).includes(issued.token), false);
    assert.equal(JSON.stringify(store.list()).includes("token_hash"), false);
    store.close();
    store = openServiceTokenStore(path);
    assert.equal(store.authenticate(issued.token)?.name, "api-reader");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("revocation is immediate across connections and permits reissuing the caller name", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-token-revoke-"));
  const path = join(directory, "deploy.sqlite");
  const server = openServiceTokenStore(path);
  const cli = openServiceTokenStore(path);
  try {
    const issued = cli.issue({ name: "api", capability: "manage" });
    assert.equal(server.authenticate(issued.token)?.capability, "manage");
    assert.throws(
      () => server.issue({ name: "api", capability: "read" }),
      /active deploy service token/u,
    );
    assert.ok(cli.revoke("api")?.revokedAt);
    assert.equal(server.authenticate(issued.token), null);
    assert.equal(cli.revoke("api"), null);
    const replacement = cli.issue({ name: "api", capability: "read" });
    assert.notEqual(replacement.token, issued.token);
    assert.notEqual(replacement.record.id, issued.record.id);
    assert.equal(server.authenticate(replacement.token)?.capability, "read");
    assert.equal(server.list().length, 2);
    assert.equal(server.list().filter((record) => record.revokedAt !== null).length, 1);
  } finally {
    cli.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("invalid, unknown and foreign service credentials are rejected without exposing input", () => {
  const store = openServiceTokenStore(":memory:");
  try {
    for (const token of [
      "",
      "secret\nvalue",
      "usk_" + "a".repeat(43),
      "udt_" + "a".repeat(43),
      "udt_" + "a".repeat(44),
    ]) {
      assert.equal(store.authenticate(token), null);
    }
    for (const options of [
      { name: "../private", capability: "read" },
      { name: "api", capability: "write" },
      { name: "api" },
      { name: "api", capability: "read", unexpected: "secret-value" },
    ]) {
      assert.throws(() => store.issue(options as never), {
        message: "A valid caller name and explicit read or manage capability are required.",
      });
    }
    assert.throws(() => store.revoke("secret\nvalue"), {
      message: "A valid caller name is required.",
    });
    assert.deepEqual(store.list(), []);
  } finally {
    store.close();
  }
});

void test("initialization faults release the database and lookup database faults remain errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-token-fault-"));
  const path = join(directory, "deploy.sqlite");
  try {
    const db = new Database(path);
    db.exec("CREATE TABLE deploy_service_tokens (id TEXT)");
    assert.throws(() => openServiceTokenStore(path), /no such column/u);
    db.exec("DROP TABLE deploy_service_tokens");
    db.close();
    const store = openServiceTokenStore(path);
    const breaker = new Database(path);
    breaker.exec("DROP TABLE deploy_service_tokens");
    assert.throws(() => store.authenticate("udt_" + "a".repeat(43)), /no such table/u);
    breaker.close();
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
