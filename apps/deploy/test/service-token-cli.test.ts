import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runServiceTokenCli } from "../src/cli/service-token.js";
import { openServiceTokenStore } from "../src/service-tokens/store.js";

void test("CLI requires explicit capability, rejects ambiguous flags, and prints the issued token once", () => {
  const store = openServiceTokenStore(":memory:");
  const lines: string[] = [];
  const deps = {
    store,
    write: (line: string) => {
      lines.push(line);
    },
  };
  try {
    for (const argv of [
      [],
      ["unknown"],
      ["list", "extra"],
      ["issue", "--name", "api"],
      ["issue", "--name", "api", "--capability", "write"],
      ["issue", "--name", "api", "--name", "other"],
      ["issue", "--name", "api", "--unknown", "read"],
      ["issue", "--name", "secret\nvalue", "--capability", "read"],
      ["revoke", "--name", "secret\nvalue"],
      ["revoke", "--other", "api"],
    ]) {
      assert.equal(runServiceTokenCli(argv, deps), 2);
      assert.match(lines.at(-1)!, /^Usage:/u);
      assert.equal(lines.at(-1)!.includes("secret\nvalue"), false);
    }
    assert.equal(runServiceTokenCli(["issue", "--capability", "read", "--name", "api"], deps), 0);
    const token = lines.at(-1)!;
    assert.match(token, /^udt_[A-Za-z0-9_-]{43}$/u);
    assert.equal(store.authenticate(token)?.name, "api");
    assert.equal(runServiceTokenCli(["list"], deps), 0);
    assert.equal(lines.at(-1)!.includes(token), false);
    assert.equal(runServiceTokenCli(["revoke", "--name", "api"], deps), 0);
    assert.equal(store.authenticate(token), null);
    assert.equal(runServiceTokenCli(["revoke", "--name", "api"], deps), 1);
  } finally {
    store.close();
  }
});

void test("real host-local CLI needs no Dokploy credentials or TLS and persists revocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "deploy-token-cli-"));
  const path = join(directory, "deploy.sqlite");
  const cli = fileURLToPath(new URL("../src/cli/service-token.ts", import.meta.url));
  const run = (argv: string[], databasePath = path) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, DEPLOY_DATABASE_PATH: databasePath, NODE_ENV: "production" },
    });
  try {
    const issued = run(["issue", "--name", "api", "--capability", "manage"]);
    assert.ifError(issued.error);
    assert.equal(issued.status, 0, issued.stderr);
    const token = issued.stdout.trim();
    assert.match(token, /^udt_[A-Za-z0-9_-]{43}$/u);
    assert.equal(issued.stderr, "");
    const duplicate = run(["issue", "--name", "api", "--capability", "manage"]);
    assert.equal(duplicate.status, 2);
    assert.equal(duplicate.stderr, "Deploy service token command failed.\n");
    const listed = run(["list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.includes(token), false);
    assert.equal(listed.stdout.includes("token_hash"), false);
    const store = openServiceTokenStore(path);
    try {
      assert.equal(store.authenticate(token)?.capability, "manage");
      assert.equal(run(["revoke", "--name", "api"]).status, 0);
      assert.equal(store.authenticate(token), null);
    } finally {
      store.close();
    }
    assert.equal(run(["list"], " ").status, 2);
    assert.equal(run(["issue", "--name", "api"]).status, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
