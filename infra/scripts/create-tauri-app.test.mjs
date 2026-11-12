import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTauriApp } from "./create-tauri-app.mjs";

test("generates isolated local IPC app and refuses overwrite and traversal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tauri-generator-"));
  try {
    const options = { root, name: "counter", identifier: "dev.unimatrix.counter" };
    const destination = await createTauriApp(options);
    const config = JSON.parse(
      await readFile(path.join(destination, "src-tauri/tauri.conf.json"), "utf8"),
    );
    assert.equal(config.identifier, options.identifier);
    assert.equal(config.app.enableGTKAppId, true);
    assert.equal(config.bundle.active, false);
    const icon = await readFile(path.join(destination, "src-tauri/icons/icon.png"));
    assert.equal(icon.subarray(1, 4).toString(), "PNG");
    assert.match(config.app.security.csp, /connect-src ipc: http:\/\/ipc.localhost$/);
    const capability = JSON.parse(
      await readFile(path.join(destination, "src-tauri/capabilities/main.json"), "utf8"),
    );
    assert.deepEqual(capability.permissions, []);
    await assert.rejects(access(path.join(destination, "Dockerfile")));
    await assert.rejects(createTauriApp(options), /EEXIST/);
    assert.equal(
      JSON.parse(await readFile(path.join(destination, "package.json"), "utf8")).name,
      "@unimatrix/counter",
    );
    for (const name of ["../escape", "UPPER", "two--words", ""])
      await assert.rejects(createTauriApp({ ...options, name }), /Name/);
    for (const identifier of ["../escape", "dev..counter", "dev.counter/escape", "dev.1bad"])
      await assert.rejects(createTauriApp({ ...options, identifier }), /Identifier/);
    await assert.rejects(createTauriApp({ ...options, port: 80 }), /Port/);
    const routed = await createTauriApp({ ...options, name: "routed", router: true, port: 1421 });
    assert.match(await readFile(path.join(routed, "src/main.tsx"), "utf8"), /RouterProvider/);
    assert.match(await readFile(path.join(routed, "src/router.tsx"), "utf8"), /createRouter/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
