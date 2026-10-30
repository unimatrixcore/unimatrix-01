import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Belt-and-braces with packages/config-eslint/restricted-imports.mjs's apps/deploy entry (scoped to
// src/reconcile/**): this reads the files directly, off disk, so it fails even if that lint rule is
// ever misconfigured or skipped. src/reconcile/ never imports src/secret-env/ or @unimatrix/secrets
// — data flows manifest -> secret-env, never the other way, and reconcile carries no write
// capability against the store.
const RECONCILE_DIR = fileURLToPath(new URL("../src/reconcile", import.meta.url));

function reconcileSourceFiles(): readonly string[] {
  // Recursive: a nested src/reconcile/<dir>/file.ts is exactly the case a non-recursive read would
  // pass over in silence, and silence here is indistinguishable from a clean result.
  return readdirSync(RECONCILE_DIR, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(RECONCILE_DIR, entry));
}

// Matches an import specifier, not `@unimatrix/secrets-app`'s packageName string in the generated
// manifest — a bare `includes("@unimatrix/secrets")` false-positives on that.
const SECRETS_IMPORT_SPECIFIER = /["']@unimatrix\/secrets(?:\/[^"']*)?["']/u;

void test("no file under src/reconcile/ names secret-env or @unimatrix/secrets", () => {
  const offenders: string[] = [];

  for (const path of reconcileSourceFiles()) {
    const source = readFileSync(path, "utf8");

    if (
      source.includes("secret-env") ||
      /dokploy\/(?:transport|env-client|env-line)/u.test(source) ||
      SECRETS_IMPORT_SPECIFIER.test(source)
    ) {
      offenders.push(path);
    }
  }

  assert.deepEqual(offenders, []);
});

void test("src/reconcile/ actually has files to check", () => {
  // A canary for the test above: if this ever reports zero, the glob broke and the assertion above
  // would pass on an empty set instead of checking anything.
  assert.ok(reconcileSourceFiles().length > 0);
});
