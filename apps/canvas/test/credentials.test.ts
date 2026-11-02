import assert from "node:assert/strict";
import test from "node:test";
import { CanvasConnectionError } from "@unimatrix/canvas";
import { createSecretsClient } from "@unimatrix/secrets/client";

import { createCanvasCredentialLoader } from "../src/credentials.js";

void test("the existing client loads only the declared Canvas name without caching", async () => {
  let value = "synthetic-token-a";
  let calls = 0;
  const loader = createCanvasCredentialLoader(
    createSecretsClient({
      baseUrl: "https://secrets.example",
      serviceToken: "synthetic-bootstrap-reader",
      fetch: (input, init) => {
        calls++;
        const url = new URL(input instanceof Request ? input.url : input.toString());
        assert.equal(url.pathname, "/secrets/value");
        assert.equal(url.searchParams.get("name"), "integrations/canvas/access-token");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer synthetic-bootstrap-reader",
        );
        return Promise.resolve(Response.json({ name: "integrations/canvas/access-token", value }));
      },
    }),
  );
  assert.equal(await loader(), value);
  value = "synthetic-token-b";
  assert.equal(await loader(), value);
  assert.equal(calls, 2);
});

void test("malformed store responses and native errors cannot escape the credential boundary", async () => {
  for (const fetch of [
    () => Promise.reject(new Error("private-bootstrap-reader")),
    () => Promise.resolve(new Response("private-canvas-token")),
    () => Promise.resolve(Response.json({ value: "private-canvas-token" })),
  ]) {
    const loader = createCanvasCredentialLoader(
      createSecretsClient({
        baseUrl: "https://secrets.example",
        serviceToken: "private-bootstrap-reader",
        fetch,
      }),
    );
    await assert.rejects(loader(), (error: unknown) => {
      assert.ok(error instanceof CanvasConnectionError);
      assert.equal(error.code, "CREDENTIAL_UNAVAILABLE");
      assert.ok(!JSON.stringify(error).includes("private-"));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
