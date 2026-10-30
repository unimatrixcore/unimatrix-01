import assert from "node:assert/strict";
import test from "node:test";
import { SecretValue } from "@unimatrix/secrets/client";

import { createDokployClient } from "../src/dokploy/client.js";
import { createDokployEnvClient } from "../src/dokploy/env-client.js";
import { applySecretEnv } from "../src/secret-env/apply.js";
import { mergeSecretEnv } from "../src/secret-env/merge.js";
import { runReconcileCli } from "../src/cli/reconcile.js";
import { DEPLOY_DESIRED_STATE } from "../src/reconcile/desired-state.gen.js";

const secret = (value: string) => new SecretValue(value);
const values = new Map([["KEY", secret("fixture")]]);

void test("merge preserves unrelated bytes, reference syntax, comments, blanks and CRLF", () => {
  const original = '# comment\r\nIMAGE_TAG=${{project.IMAGE_TAG}}\r\n\r\nOTHER="a=b"\r\nKEY=old';
  const result = mergeSecretEnv(secret(original), values, true);
  assert.equal(result.env.reveal(), original.replace("KEY=old", "KEY=fixture"));
  assert.equal(JSON.stringify(result).includes("fixture"), false);
  assert.deepEqual(result.changed, ["KEY"]);
  assert.equal(
    mergeSecretEnv(secret("OTHER=x"), values, false).env.reveal(),
    "OTHER=x\nKEY=fixture\n",
  );
  assert.equal(
    mergeSecretEnv(secret("OTHER=x\r\n"), values, false).env.reveal(),
    "OTHER=x\r\nKEY=fixture\r\n",
  );
  assert.equal(mergeSecretEnv(secret(""), values, false).env.reveal(), "KEY=fixture\n");
  for (const existing of [' KEY = "fixture" ', "KEY='fixture'", "KEY=fixture\n"]) {
    assert.deepEqual(mergeSecretEnv(secret(existing), values, false).changed, []);
  }
  assert.deepEqual(mergeSecretEnv(secret("KEY=old\r\n"), values, true).changed, ["KEY"]);
  assert.equal(mergeSecretEnv(secret("KEY=old\n"), values, true).env.reveal(), "KEY=fixture\n");
});

void test("merge refuses duplicate declared keys, blanks, multiline and unapproved overwrites", () => {
  for (const existing of ["KEY=old", "KEY=", "KEY=a\nKEY=b"]) {
    assert.deepEqual(mergeSecretEnv(secret(existing), values, false).refused, ["KEY"]);
  }
  for (const value of ["", "  ", "a\nb", "a\rb", "a\0b"]) {
    assert.deepEqual(mergeSecretEnv(secret(""), new Map([["KEY", secret(value)]]), true).refused, [
      "KEY",
    ]);
  }
});

function fixture(
  options: {
    blob?: string | null;
    write?: "drop" | "throw";
    readFail?: number;
    projectsFail?: boolean;
    matches?: number;
    owner?: string;
    repository?: string;
    sourceType?: string;
    id?: string;
    storeFail?: boolean;
  } = {},
) {
  let blob = options.blob === undefined ? "IMAGE_TAG=${{project.IMAGE_TAG}}\n" : options.blob;
  let reads = 0;
  let writes = 0;
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.pathname);
    if (url.pathname.endsWith("project.all")) {
      assert.equal(calls.filter((entry) => entry === "store").length, 3);
      if (options.projectsFail) throw new Error("PRIVATE");
      return Response.json([
        {
          projectId: "p",
          name: "p",
          environments: [
            {
              environmentId: "e",
              name: "e",
              compose: Array.from({ length: options.matches ?? 1 }, (_, index) => ({
                composeId: `c${index}`,
                composeStatus: "done",
                name: "api",
              })),
            },
          ],
        },
      ]);
    }
    if (init?.method === "POST") {
      writes++;
      const payload = JSON.parse(typeof init.body === "string" ? init.body : "") as {
        composeId: string;
        env: string;
      };
      assert.equal(payload.composeId, "c0");
      assert.equal(payload.env.includes("[REDACTED]"), false);
      assert.ok(payload.env.includes("CLERK_SECRET_KEY=fixture-platform/clerk-secret-key"));
      if (options.write !== "drop") blob = payload.env;
      if (options.write === "throw") throw new Error("PRIVATE");
      return {
        ok: true,
        json: () => {
          throw new Error("must not read success body");
        },
      } as unknown as Response;
    }
    reads++;
    if (reads === options.readFail) throw new Error("PRIVATE");
    return Response.json({
      composeId: options.id ?? "c0",
      env: blob,
      owner: options.owner ?? "unimatrixcore",
      repository: options.repository ?? "unimatrix-01",
      sourceType: options.sourceType ?? "github",
    });
  };
  const config = { baseUrl: "http://dokploy", apiKey: "test", fetch };
  const client = createDokployClient(config);
  const envClient = createDokployEnvClient(config);
  const store = {
    getSecretValue: async (name: string) => {
      await Promise.resolve();
      calls.push("store");
      if (options.storeFail) throw new Error("PRIVATE");
      return secret(`fixture-${name}`);
    },
  };
  return { client, envClient, store, calls, writes: () => writes, reads: () => reads };
}

void test("apply resolves all names first, writes plaintext once, and confirms the post-write values", async () => {
  const f = fixture();
  assert.equal((await applySecretEnv(f.client, f.envClient, f.store, "api")).outcome, "applied");
  assert.equal(f.writes(), 1);
  assert.equal(f.reads(), 2);
  assert.equal((await applySecretEnv(f.client, f.envClient, f.store, "deploy")).outcome, "refused");
  assert.equal(
    (await applySecretEnv(f.client, f.envClient, f.store, "unknown")).outcome,
    "refused",
  );
  assert.equal((await applySecretEnv(f.client, f.envClient, f.store, "web")).outcome, "in-sync");
});

void test("apply refuses failures and unsafe targets without writing", async () => {
  for (const options of [
    { storeFail: true },
    { matches: 0 },
    { matches: 2 },
    { owner: "foreign" },
    { repository: "foreign" },
    { sourceType: "git" },
    { id: "wrong" },
    { blob: "CLERK_SECRET_KEY=old" },
  ]) {
    const f = fixture(options);
    const result = await applySecretEnv(f.client, f.envClient, f.store, "api");
    assert.equal(result.outcome, "refused");
    assert.equal(f.writes(), 0);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    if (options.storeFail) assert.deepEqual(f.calls, ["store", "store", "store"]);
  }
});

void test("apply reports reads, dropped writes, uncertain writes, and in-sync separately", async () => {
  const cases = [
    [{ projectsFail: true }, "error"],
    [{ readFail: 1 }, "error"],
    [{ readFail: 2 }, "write-status-unknown"],
    [{ write: "throw" }, "write-status-unknown"],
    [{ write: "drop" }, "verification-failed"],
  ] as const;
  for (const [options, expected] of cases) {
    const f = fixture(options);
    assert.deepEqual(
      (await applySecretEnv(f.client, f.envClient, f.store, "api")).outcome,
      expected,
    );
  }
  const keys = [
    "CLERK_SECRET_KEY=fixture-platform/clerk-secret-key",
    "CLERK_PUBLISHABLE_KEY=fixture-platform/clerk-publishable-key",
    "CLERK_JWT_KEY=fixture-platform/clerk-jwt-key",
  ].join("\n");
  const synced = fixture({ blob: keys });
  assert.equal(
    (await applySecretEnv(synced.client, synced.envClient, synced.store, "api")).outcome,
    "in-sync",
  );
  assert.equal(synced.writes(), 0);
  const overwrite = fixture({ blob: "CLERK_SECRET_KEY=old" });
  assert.equal(
    (await applySecretEnv(overwrite.client, overwrite.envClient, overwrite.store, "api", true))
      .outcome,
    "applied",
  );
});

void test("CLI requires explicit secrets-apply, rejects flags, and exposes no values", async () => {
  for (const [args, expected] of [
    [["secrets-apply", "api"], 0],
    [["secrets-apply", "api", "--overwrite"], 0],
    [["secrets-apply", "web"], 1],
    [["secrets-apply", "api", "--force"], 2],
  ] as const) {
    const f = fixture();
    const output: string[] = [];
    assert.equal(
      await runReconcileCli(args, {
        client: f.client,
        envClient: f.envClient,
        secretEnv: f.store,
        desired: DEPLOY_DESIRED_STATE,
        write: (line) => {
          output.push(line);
        },
      }),
      expected,
    );
    assert.equal(output.join("\n").includes("fixture-platform"), false);
  }
  const f = fixture();
  assert.equal(
    await runReconcileCli(["secrets-apply", "api"], {
      client: f.client,
      secretEnv: null,
      desired: DEPLOY_DESIRED_STATE,
      write: () => {},
    }),
    2,
  );
});

void test("merge quotes dotenv syntax as literal data and compares its encoded value on a re-read", () => {
  for (const value of ["abc #def", "${OTHER}", "a'b", '"quoted"', "a\\nb", " padded ", "a\\'b"]) {
    const resolved = new Map([["KEY", secret(value)]]);
    const written = mergeSecretEnv(secret(""), resolved, false);
    assert.deepEqual(written.refused, []);
    assert.ok(written.env.reveal().startsWith('KEY="'));
    assert.deepEqual(mergeSecretEnv(written.env, resolved, false).changed, []);
  }
  assert.deepEqual(
    mergeSecretEnv(secret(""), new Map([["KEY", secret("${{project.KEY}}")]]), false).refused,
    ["KEY"],
  );
});

void test("dollar signs are doubled on the env wire", () => {
  assert.equal(
    mergeSecretEnv(secret(""), new Map([["KEY", secret("${OTHER}")]]), false).env.reveal(),
    'KEY="$${OTHER}"\n',
  );
});

void test("existing interpolation and inline comments cannot masquerade as literal values", () => {
  for (const value of ["${OTHER}", "abc #def"]) {
    assert.deepEqual(
      mergeSecretEnv(secret(`KEY=${value}`), new Map([["KEY", secret(value)]]), false).refused,
      ["KEY"],
    );
  }
  assert.deepEqual(mergeSecretEnv(secret('KEY="bad\\q"'), values, false).refused, ["KEY"]);
});

void test("merge rejects keys that cannot be one environment assignment", () => {
  for (const key of [
    "BAD=NAME",
    "BAD\rNAME",
    "BAD\nNAME",
    "",
    " PAD ",
    "#BAD",
    "BAD\0NAME",
    "1BAD",
  ]) {
    const result = mergeSecretEnv(
      secret("UNCHANGED=value\n"),
      new Map([[key, secret("fixture")]]),
      true,
    );
    assert.deepEqual(result.refused, [key]);
    assert.equal(result.env.reveal(), "UNCHANGED=value\n");
  }
});

void test("apply refuses export and multiline dotenv syntax before any write", async () => {
  for (const blob of [
    "export CLERK_SECRET_KEY=old\n",
    'OTHER="first\nCLERK_SECRET_KEY=old\nlast"\n',
    "OTHER='first\nCLERK_SECRET_KEY=old\nlast'\n",
  ]) {
    for (const overwrite of [false, true]) {
      const f = fixture({ blob });
      const result = await applySecretEnv(f.client, f.envClient, f.store, "api", overwrite);
      assert.equal(result.outcome, "refused");
      assert.equal(f.writes(), 0);
      assert.equal(f.reads(), 1);
    }
  }
});

void test("merge preserves unsupported blobs and accepts only complete physical assignments", () => {
  for (const blob of [
    'KEY="unterminated',
    'OTHER="done"junk\n',
    "OTHER=value\rmore\n",
    "OTHER=a\0b",
    "OTHER: value",
    "OTHER",
  ]) {
    const result = mergeSecretEnv(secret(blob), values, true);
    assert.deepEqual(result.refused, ["KEY"]);
    assert.equal(result.env.reveal(), blob);
  }
  for (const blob of [
    "OTHER='a\\'b' # comment\n",
    'OTHER="a\\"b"\n',
    'OTHER="done"\n',
    "OTHER=value\n",
  ]) {
    assert.deepEqual(mergeSecretEnv(secret(blob), values, false).refused, []);
  }
});

void test("quoted assignments with trailing comments remain in sync without rewriting", () => {
  for (const blob of [
    'KEY="fixture" # retained\n',
    "KEY='fixture'# retained\n",
    "KEY=fixture # retained\n",
  ]) {
    const result = mergeSecretEnv(secret(blob), values, false);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.changed, []);
    assert.equal(result.env.reveal(), blob);
  }
});
