import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTauriApp } from "./create-tauri-app.mjs";

const execFileAsync = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");

test("generated Cargo workspace coexists with the repository workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tauri-cargo-workspace-"));
  try {
    await writeFile(
      path.join(root, "Cargo.toml"),
      await readFile(path.join(repository, "Cargo.toml")),
    );
    for (const [directory, target] of [
      ["packages/desktop-runtime", "lib.rs"],
      ["packages/poker-native", "lib.rs"],
      ["apps/poker/src-tauri", "main.rs"],
      ["apps/poker-assistant/src-tauri", "main.rs"],
    ]) {
      await mkdir(path.join(root, directory, "src"), { recursive: true });
      await writeFile(
        path.join(root, directory, "Cargo.toml"),
        await readFile(path.join(repository, directory, "Cargo.toml")),
      );
      await writeFile(path.join(root, directory, "src", target), "");
    }
    const app = await createTauriApp({ root, name: "counter", identifier: "dev.test.counter" });
    const manifest = path.join(app, "src-tauri", "Cargo.toml");
    const { stdout } = await execFileAsync("cargo", [
      "metadata",
      "--offline",
      "--no-deps",
      "--format-version",
      "1",
      "--manifest-path",
      manifest,
    ]);
    const metadata = JSON.parse(stdout);
    assert.equal(metadata.workspace_root, path.join(app, "src-tauri"));
    assert.equal(metadata.workspace_members.length, 1);
    assert.ok(
      metadata.packages[0].dependencies.some(
        (dependency) => dependency.name === "unimatrix-desktop",
      ),
    );
    const rootMetadata = JSON.parse(
      (
        await execFileAsync("cargo", [
          "metadata",
          "--offline",
          "--no-deps",
          "--format-version",
          "1",
          "--manifest-path",
          path.join(root, "Cargo.toml"),
        ])
      ).stdout,
    );
    const memberNames = rootMetadata.packages
      .filter((entry) => rootMetadata.workspace_members.includes(entry.id))
      .map((entry) => entry.name);
    for (const name of [
      "unimatrix-desktop",
      "poker-native",
      "unimatrix-poker",
      "unimatrix-poker-assistant",
    ]) {
      assert.ok(memberNames.includes(name));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const main = await readFile(path.join(destination, "src/main.tsx"), "utf8");
    assert.match(
      main,
      /configureListMemoryProvider\(\(\) => client\(getSystemMemoryInfo, null\)\)/,
    );
    assert.match(main, /const queryClient = createInstantQueryClient\(\)/);
    const commands = await readFile(path.join(destination, "src/commands.ts"), "utf8");
    assert.match(commands, /name: "get_system_memory_info"/);
    assert.match(commands, /availableBytes <= memory.totalBytes/);
    const rust = await readFile(path.join(destination, "src-tauri/src/main.rs"), "utf8");
    assert.match(rust, /async fn get_system_memory_info\(input: \(\)\)/);
    assert.match(rust, /spawn_blocking\(\|\|/);
    assert.match(
      rust,
      /generate_handler!\[\s*read_counter,\s*save_counter,\s*get_system_memory_info\s*\]/,
    );
    const manifest = JSON.parse(await readFile(path.join(destination, "package.json"), "utf8"));
    assert.equal(manifest.dependencies["@unimatrix/instant-list"], "workspace:*");
    const typescript = JSON.parse(await readFile(path.join(destination, "tsconfig.json"), "utf8"));
    assert.deepEqual(typescript.compilerOptions.paths["@unimatrix/instant-list"], [
      "../../packages/instant-list/src/index.ts",
    ]);
    await assert.rejects(access(path.join(destination, "Dockerfile")));
    await assert.rejects(createTauriApp(options), /already exists/);
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

test("rejects workspace name collisions by manifest name before creating an app", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tauri-collision-"));
  try {
    for (const location of ["packages/shared-ui", "apps/web", "lab"]) {
      await mkdir(path.join(root, location), { recursive: true });
      const manifest = path.join(root, location, "package.json");
      const content = JSON.stringify({ name: "@unimatrix/counter" });
      await writeFile(manifest, content);
      await assert.rejects(
        createTauriApp({ root, name: "counter", identifier: "dev.test.counter" }),
        /Workspace package already exists/,
      );
      await assert.rejects(access(path.join(root, "apps/counter")));
      assert.equal(await readFile(manifest, "utf8"), content);
      await rm(path.join(root, location), { recursive: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validates programmatic option types before filesystem writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tauri-options-"));
  try {
    const options = { root, name: "counter", identifier: "dev.test.counter" };
    for (const invalid of [
      { router: "false" },
      { root: 123 },
      { root: "relative" },
      { port: "1420" },
      { typo: true },
    ]) {
      await assert.rejects(createTauriApp({ ...options, ...invalid }));
      await assert.rejects(access(path.join(root, "apps")));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
