import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_WORKLOAD_LOCK_DIRECTORY, parseCpuList } from "./run-local-workload.mjs";

const runner = fileURLToPath(new URL("./run-local-workload.mjs", import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "unimatrix-workload-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const harness = join(directory, "runner.mjs");
  const lockDirectory = join(directory, "lock-directory");
  writeFileSync(
    harness,
    `import {runLocalWorkload} from ${JSON.stringify(runner)};
try {
  process.exitCode = await runLocalWorkload(process.argv[2], process.argv.slice(3), {
    lockDirectory: ${JSON.stringify(lockDirectory)}
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
`,
  );
  return { directory, harness };
}

function launch(harness, args, options = {}) {
  const env = { ...process.env };
  delete env.UNIMATRIX_LOCAL_WORKLOAD;
  delete env.UNIMATRIX_CONTAINER_BUILD;
  delete env.GITHUB_ACTIONS;
  delete env.RUNNER_ENVIRONMENT;
  const child = spawn(process.execPath, [harness, ...args], {
    ...options,
    env: { ...env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const result = new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error("Timed out waiting for the trivial child process.");
}

function running(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/stat`, "utf8");
    return status.slice(status.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

test("CPU affinity parser supports sparse and single-CPU allocations", () => {
  assert.deepEqual(parseCpuList("2,4-6,9"), [2, 4, 5, 6, 9]);
  assert.deepEqual(parseCpuList("7"), [7]);
  for (const invalid of ["", "2-1", "0;1", "1-999999"]) assert.throws(() => parseCpuList(invalid));
});

test("local runs inherit CPU, scheduling, and worker bounds even with CI=true", async (t) => {
  const { harness } = fixture(t);
  const script = `
    const fs = require('node:fs');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    console.log(JSON.stringify({
      cpus: status.match(/^Cpus_allowed_list:\\s*(.+)$/m)[1],
      nice: Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[16]),
      workers: process.env.VITEST_MAX_WORKERS,
      msbuild: process.env.DOTNET_CLI_USE_MSBUILD_SERVER,
      compiler: process.env.UseSharedCompilation,
    }));`;
  const result = await launch(harness, [process.execPath, "-e", script], {
    env: { CI: "true", UNIMATRIX_LOCAL_WORKLOAD: "{}" },
  }).result;
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.ok(parseCpuList(value.cpus).length <= 2);
  assert.ok(value.nice >= 10);
  assert.equal(value.workers, "1");
  assert.equal(value.msbuild, "0");
  assert.equal(value.compiler, "false");
});

test("separate working directories and TMPDIR values share one kernel lock", async (t) => {
  const { directory, harness } = fixture(t);
  const events = join(directory, "events");
  const script = `
    const fs = require('node:fs');
    fs.appendFileSync(process.argv[1], 'start '+process.argv[2]+'\\n');
    setTimeout(() => fs.appendFileSync(process.argv[1], 'end '+process.argv[2]+'\\n'), 80);`;
  assert.equal(LOCAL_WORKLOAD_LOCK_DIRECTORY, `/tmp/unimatrix-local-workload-${process.getuid()}`);
  const first = launch(harness, [process.execPath, "-e", script, events, "first"], {
    cwd: "/tmp",
    env: { TMPDIR: "/tmp/session-one" },
  });
  const second = launch(harness, [process.execPath, "-e", script, events, "second"], {
    cwd: "/",
    env: { TMPDIR: "/tmp/session-two" },
  });
  const results = await Promise.all([first.result, second.result]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const lines = readFileSync(events, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], lines[0].replace("start", "end"));
  assert.equal(lines[3], lines[2].replace("start", "end"));
  assert.notEqual(lines[0], lines[2]);
});

test("nested wrappers reenter a verified ancestor lock and preserve arguments and status", async (t) => {
  const { harness } = fixture(t);
  const argument = "spaces; $(not-a-shell) ' and \\\"";
  const result = await launch(harness, [
    process.execPath,
    harness,
    process.execPath,
    "-e",
    "console.log(JSON.stringify(process.argv[1])); process.exitCode = 17;",
    argument,
  ]).result;
  assert.equal(result.code, 17, result.stderr);
  assert.equal(JSON.parse(result.stdout), argument);
  assert.equal(result.stderr.match(/waiting for the shared/gu)?.length, 1);
});

test("SIGTERM stops the workload group and its child before releasing the lock", async (t) => {
  const { directory, harness } = fixture(t);
  const pidFile = join(directory, "pids");
  const script = `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
    fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
    setInterval(() => {}, 1000);`;
  const run = launch(harness, [process.execPath, "-e", script, pidFile]);
  t.after(() => run.child.kill("SIGKILL"));
  let pids;
  await waitUntil(() => {
    try {
      pids = JSON.parse(readFileSync(pidFile, "utf8"));
      return true;
    } catch {
      return false;
    }
  });
  run.child.kill("SIGTERM");
  const result = await run.result;
  assert.equal(result.code, 143, result.stderr);
  await waitUntil(() => pids.every((pid) => !running(pid)));
  const next = await launch(harness, [process.execPath, "-e", "process.exitCode = 0"]).result;
  assert.equal(next.code, 0, next.stderr);
});

test("normal failure cleans up detached background children before releasing the lock", async (t) => {
  const { directory, harness } = fixture(t);
  const pidFile = join(directory, "pid");
  const script = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e','setInterval(() => {}, 1000)'], {stdio:'ignore', detached: true});
    require('node:fs').writeFileSync(process.argv[1], String(child.pid));
    child.unref(); process.exitCode = 23;`;
  const result = await launch(harness, [process.execPath, "-e", script, pidFile]).result;
  assert.equal(result.code, 23, result.stderr);
  await waitUntil(() => !running(Number(readFileSync(pidFile, "utf8"))));
});

test("hosted CI and generated container builds preserve their environment and exit status", async (t) => {
  const { harness } = fixture(t);
  for (const env of [
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" },
    { UNIMATRIX_CONTAINER_BUILD: "1" },
  ]) {
    const result = await launch(
      harness,
      [process.execPath, "-e", "console.log(process.env.VITEST_MAX_WORKERS); process.exitCode=19"],
      {
        env: { ...env, VITEST_MAX_WORKERS: "3" },
      },
    ).result;
    assert.equal(result.code, 19, result.stderr);
    assert.equal(result.stdout.trim(), "3");
    assert.equal(result.stderr, "");
  }
});
