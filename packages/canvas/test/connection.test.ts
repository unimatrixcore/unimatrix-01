import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { CanvasConnectionError, createCanvasConnection } from "../src/index.js";

const userId = "90071992547409931234";
const secretA = "synthetic-private-token-A";
const secretB = "synthetic-private-token-B";

function fixture() {
  let secret = secretA;
  let account = userId;
  let status = 200;
  let payload: unknown;
  let storeError: Error | undefined;
  let fetchError: Error | undefined;
  let loads = 0;
  let changes = 0;
  let cache: string | undefined;
  const requests: RequestInit[] = [];
  const connection = createCanvasConnection({
    userId,
    loadCredential: (signal) => {
      assert.ok(signal);
      loads++;
      return storeError ? Promise.reject(storeError) : Promise.resolve(secret);
    },
    fetch: (url, init) => {
      assert.equal(url, "https://learn.maricopa.edu/api/v1/users/self");
      assert.equal(init?.redirect, "error");
      assert.equal(init.method, "GET");
      assert.ok(init.signal);
      requests.push(init);
      return fetchError
        ? Promise.reject(fetchError)
        : Promise.resolve(Response.json(payload ?? { id: account }, { status }));
    },
    onCredentialChange: () => {
      changes++;
      cache = undefined;
    },
  });
  return {
    connection,
    requests,
    replace: (value: string) => {
      secret = value;
    },
    account: (value: string) => {
      account = value;
    },
    status: (value: number) => {
      status = value;
    },
    payload: (value: unknown) => {
      payload = value;
    },
    deny: (error: Error) => {
      storeError = error;
    },
    failFetch: (error: Error) => {
      fetchError = error;
    },
    counts: () => ({ loads, changes }),
    cached: () =>
      connection.withVerifiedCredential((token) => {
        cache ??= token === secretA ? "content A" : "content B";
        return Promise.resolve(cache);
      }),
  };
}

await test("every cache hit rechecks the store and account; replacement invalidates content", async () => {
  const f = fixture();
  assert.equal(await f.cached(), "content A");
  assert.equal(await f.cached(), "content A");
  assert.deepEqual(f.counts(), { loads: 2, changes: 1 });
  assert.equal(f.requests.length, 2);
  assert.equal(
    new Headers(f.requests[0]?.headers).get("accept"),
    "application/json+canvas-string-ids",
  );
  assert.equal(new Headers(f.requests[0]?.headers).get("authorization"), `Bearer ${secretA}`);
  f.replace(secretB);
  assert.equal(await f.cached(), "content B");
  assert.deepEqual(f.counts(), { loads: 3, changes: 2 });
  assert.equal(f.requests.length, 3);
});

await test("replaced credential belonging to another account cannot read cached content", async () => {
  const f = fixture();
  await f.cached();
  f.replace(secretB);
  f.account("1234");
  await assert.rejects(f.cached(), { code: "CANVAS_ACCOUNT_MISMATCH", statusCode: 409 });
  assert.deepEqual(f.counts(), { loads: 2, changes: 2 });
  f.account(userId);
  assert.equal(await f.cached(), "content B");
});

await test("same credential is checked for upstream expiry and revocation on every operation", async () => {
  for (const status of [401, 403]) {
    const f = fixture();
    await f.cached();
    f.status(status);
    await assert.rejects(f.cached(), { code: "CANVAS_CREDENTIAL_REJECTED", statusCode: 502 });
    assert.equal(f.requests.length, 2);
  }
});

await test("store denial missing key and failure never reuse a previous credential or cached content", async () => {
  for (const code of [
    "CREDENTIAL_DENIED",
    "CREDENTIAL_MISSING",
    "CREDENTIAL_UNAVAILABLE",
  ] as const) {
    const f = fixture();
    await f.cached();
    f.deny(new CanvasConnectionError(code));
    await assert.rejects(f.cached(), { code, statusCode: 503 });
    assert.equal(f.requests.length, 1);
  }
  const f = fixture();
  f.deny(new Error(secretA));
  await assert.rejects(f.cached(), { code: "CREDENTIAL_UNAVAILABLE" });
});

await test("account payloads require lossless string IDs and bounded valid JSON", async () => {
  for (const payload of [
    { id: 1234 },
    { id: "" },
    { id: "1e3" },
    { error: secretA },
    { id: userId, extra: "x".repeat(65_536) },
  ]) {
    const f = fixture();
    f.payload(payload);
    await assert.rejects(f.connection.status(), { code: "CANVAS_INVALID_RESPONSE" });
  }
  const invalid = createCanvasConnection({
    userId,
    loadCredential: () => Promise.resolve(secretA),
    fetch: () => Promise.resolve(new Response(`invalid ${secretA}`)),
  });
  await assert.rejects(invalid.status(), { code: "CANVAS_INVALID_RESPONSE" });
});

await test("errors discard store fetch response and workflow secrets", async () => {
  const f = fixture();
  f.failFetch(new Error(secretA, { cause: secretB }));
  const operations = [
    () => f.connection.status(),
    () => fixture().connection.withVerifiedCredential(() => Promise.reject(new Error(secretB))),
  ];
  for (const run of operations) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof CanvasConnectionError);
      const output = [String(error), JSON.stringify(error), inspect(error)].join("\n");
      assert.ok(!output.includes(secretA));
      assert.ok(!output.includes(secretB));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  const unavailable = fixture();
  unavailable.status(500);
  unavailable.payload({ secret: secretA });
  await assert.rejects(unavailable.connection.status(), { code: "CANVAS_UNAVAILABLE" });
});

await test("aborted queued operation skips credentials and preserves ordering for following operations", async () => {
  const f = fixture();
  let release!: () => void;
  const active = f.connection.withVerifiedCredential(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = f.connection.status(controller.signal);
  controller.abort(new Error(secretA));
  await assert.rejects(queued, { code: "REQUEST_CANCELLED" });
  const following = f.connection.status();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.counts().loads, 1);
  release();
  await active;
  assert.deepEqual(await following, { connection: "connected" });
  assert.equal(f.counts().loads, 2);
});

await test("pre-cancelled operation performs no store or upstream requests", async () => {
  const f = fixture();
  await assert.rejects(f.connection.status(AbortSignal.abort(secretA)), {
    code: "REQUEST_CANCELLED",
  });
  assert.equal(f.counts().loads, 0);
  assert.equal(f.requests.length, 0);
});

await test("cancellation reaches the store and upstream without serializing its reason", async () => {
  for (const stage of ["store", "upstream"]) {
    const controller = new AbortController();
    const connection = createCanvasConnection({
      userId,
      loadCredential: () => {
        if (stage === "store") {
          controller.abort(new Error(secretA));
          return Promise.reject(new Error(secretA));
        }
        return Promise.resolve(secretA);
      },
      fetch: () => {
        controller.abort(new Error(secretB));
        return Promise.reject(new Error(secretB));
      },
    });
    await assert.rejects(connection.status(controller.signal), (error: unknown) => {
      assert.ok(error instanceof CanvasConnectionError);
      assert.equal(error.code, "REQUEST_CANCELLED");
      assert.ok(!inspect(error).includes(secretA));
      assert.ok(!inspect(error).includes(secretB));
      return true;
    });
  }
});

await test("account configuration and empty or unsafe credentials fail closed", async () => {
  assert.throws(() =>
    createCanvasConnection({
      userId: "user_clerk",
      loadCredential: () => Promise.resolve(secretA),
    }),
  );
  for (const value of [
    "",
    "unsafe\r\nheader",
    " leading-space",
    "trailing-space ",
    "non-ascii-🔥",
  ]) {
    const f = fixture();
    f.replace(value);
    await assert.rejects(f.connection.status(), { code: "CREDENTIAL_DENIED" });
    assert.equal(f.requests.length, 0);
  }
});

await test("failed generation invalidation retries before account verification and passes the deadline to workflows", async () => {
  let invalidations = 0;
  let fetches = 0;
  const connection = createCanvasConnection({
    userId,
    loadCredential: () => Promise.resolve(secretA),
    onCredentialChange: () => {
      invalidations++;
      if (invalidations === 1) throw new Error(secretA);
    },
    fetch: () => {
      fetches++;
      return Promise.resolve(Response.json({ id: userId }));
    },
  });
  await assert.rejects(connection.status(), { code: "CANVAS_REQUEST_FAILED" });
  assert.equal(fetches, 0);
  await connection.withVerifiedCredential((token, signal) => {
    assert.equal(token, secretA);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    return Promise.resolve();
  });
  assert.equal(invalidations, 2);
  assert.equal(fetches, 1);
});
