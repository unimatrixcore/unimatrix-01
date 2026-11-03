import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deploymentLockfileInputs } from "./deploy-lockfile.mjs";

const lock = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  apps/web:
    dependencies:
      direct:
        specifier: ^1.0.0
        version: 1.0.0(peer@2.0.0)
      '@workspace/helper':
        specifier: workspace:*
        version: link:../../packages/helper
    devDependencies:
      eslint:
        specifier: ^1.0.0
        version: 1.0.0
  packages/helper:
    optionalDependencies:
      optional:
        specifier: ^1.0.0
        version: 1.0.0
  packages/unused: {}
packages:
  direct@1.0.0:
    resolution: {integrity: sha512-direct}
  peer@2.0.0:
    resolution: {integrity: sha512-peer}
  transitive@1.0.0:
    resolution: {integrity: sha512-transitive}
  optional@1.0.0:
    resolution: {integrity: sha512-optional}
  eslint@1.0.0:
    resolution: {integrity: sha512-eslint}
snapshots:
  direct@1.0.0(peer@2.0.0):
    dependencies:
      peer: 2.0.0
      transitive: 1.0.0
  peer@2.0.0: {}
  transitive@1.0.0: {}
  optional@1.0.0: {}
  eslint@1.0.0: {}
`;

const inputs = (text = lock, paths = ["apps/web"]) =>
  deploymentLockfileInputs(
    text,
    paths,
    (name, field) => field === "devDependencies" && name === "eslint",
  );

test("reachable lockfile inputs include workspace, optional and peer dependencies", () => {
  const result = inputs();
  assert.deepEqual(
    result.importers.map(([path]) => path),
    ["apps/web", "packages/helper"],
  );
  assert.deepEqual(
    result.packages.map(([name]) => name),
    ["direct@1.0.0", "optional@1.0.0", "peer@2.0.0", "transitive@1.0.0"],
  );
  assert.ok(result.snapshots.some(([name]) => name === "direct@1.0.0(peer@2.0.0)"));
});

test("unrelated importers and resolutions do not change an app fingerprint", () => {
  const addition = lock
    .replace(
      "  packages/unused: {}",
      `  packages/unused:
    dependencies:
      unrelated:
        specifier: ^1.0.0
        version: 1.0.0`,
    )
    .replace(
      "packages:\n",
      "packages:\n  unrelated@1.0.0:\n    resolution: {integrity: sha512-unrelated}\n",
    )
    .replace("snapshots:\n", "snapshots:\n  unrelated@1.0.0: {}\n");
  assert.deepEqual(inputs(addition), inputs());
  assert.deepEqual(inputs(lock.replace("sha512-eslint", "sha512-updated-eslint")), inputs());
  assert.deepEqual(
    inputs(
      lock.replace(
        "        specifier: ^1.0.0\n        version: 1.0.0\n  packages/helper:",
        "        specifier: ^2.0.0\n        version: 2.0.0\n  packages/helper:",
      ),
    ),
    inputs(),
  );
});

test("direct, transitive, peer, optional and same-version integrity updates invalidate inputs", () => {
  for (const [before, after] of [
    ["specifier: ^1.0.0", "specifier: ~1.0.0"],
    ["sha512-direct", "sha512-new-direct"],
    ["sha512-transitive", "sha512-new-transitive"],
    ["sha512-peer", "sha512-new-peer"],
    ["sha512-optional", "sha512-new-optional"],
  ])
    assert.notDeepEqual(inputs(lock.replace(before, after)), inputs());
  assert.notDeepEqual(
    inputs(
      lock
        .replaceAll("transitive@1.0.0", "transitive@2.0.0")
        .replace("transitive: 1.0.0", "transitive: 2.0.0"),
    ),
    inputs(),
  );
  assert.notDeepEqual(
    inputs(lock.replaceAll("peer@2.0.0", "peer@3.0.0").replace("peer: 2.0.0", "peer: 3.0.0")),
    inputs(),
  );
});

test("excluded importer dependencies remain included when required transitively", () => {
  const transitiveLint = lock.replace(
    "      transitive: 1.0.0",
    "      transitive: 1.0.0\n      eslint: 1.0.0",
  );
  assert.notDeepEqual(
    inputs(transitiveLint.replace("sha512-eslint", "sha512-new-eslint")),
    inputs(transitiveLint),
  );
});

test("global install settings are conservative and formatting-only blank lines are ignored", () => {
  assert.notDeepEqual(
    inputs(lock.replace("autoInstallPeers: true", "autoInstallPeers: false")),
    inputs(),
  );
  assert.deepEqual(inputs(lock.replaceAll("\n", "\n\n")), inputs());
});

test("workspace links are followed once even with cycles and empty importers", () => {
  assert.deepEqual(inputs(lock, ["packages/unused"]).importers, [["packages/unused", []]]);
  const cycle = lock.replace(
    "  packages/helper:\n",
    `  packages/helper:
    dependencies:
      web:
        specifier: workspace:*
        version: link:../../apps/web
`,
  );
  assert.equal(inputs(cycle).importers.length, 2);
});

test("uncertain lockfile structures and dependency forms throw rather than omit inputs", () => {
  for (const changed of [
    lock.replace("'9.0'", "'10.0'"),
    lock.replace("  apps/web:", "  apps/web: *alias"),
    lock.replace("  apps/web:", "  apps/web:\n  apps/web:"),
    lock.replace("    dependencies:", "    dependencies: *alias"),
    lock.replace("        version: 1.0.0(peer@2.0.0)", "        version: file:../archive.tgz"),
    lock.replace(
      "        version: link:../../packages/helper",
      "        version: link:../../missing",
    ),
    lock.replace(
      "        version: link:../../packages/helper",
      "        version: link:../../../outside",
    ),
    lock.replace("      transitive: 1.0.0", "      transitive: 2.0.0"),
    lock.replace("    dependencies:\n", "    unknownField:\n"),
    lock.replace("        specifier: ^1.0.0", "        specifier: ^1.0.0\n        extra: true"),
    lock.replace("      transitive: 1.0.0", "      transitive: *alias"),
    lock.replace("  transitive@1.0.0:\n    resolution: {integrity: sha512-transitive}\n", ""),
  ])
    assert.throws(() => inputs(changed), /lockfile|importer|snapshot|workspace/iu);
});

test("current deployable apps' canonical lockfile is supported without installed YAML tooling", () => {
  const text = readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8");
  for (const app of ["admin", "api", "auth", "cflop", "deploy", "secrets", "status", "web"]) {
    assert.doesNotThrow(() => deploymentLockfileInputs(text, [`apps/${app}`]));
  }
});
