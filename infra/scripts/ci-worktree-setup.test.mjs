import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function run(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
}
function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), "worktree-setup-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const checkout = join(temporary, "checkout's path");
  const main = join(temporary, "main");
  const bin = join(temporary, "bin");
  mkdirSync(join(checkout, "infra/scripts"), { recursive: true });
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(bin);
  for (const script of [
    "setup-worktree.mjs",
    "setup-local.mjs",
    "link-worktree-dirs.mjs",
    "pnpm-with-pinned-node.sh",
  ])
    cpSync(join(root, "infra/scripts", script), join(checkout, "infra/scripts", script));
  for (const app of ["api", "web"]) {
    mkdirSync(join(checkout, "apps", app), { recursive: true });
    writeFileSync(join(checkout, "apps", app, ".env.example"), `${app}=example\n`);
  }
  writeFileSync(join(checkout, ".node-version"), "24.18.0\n");
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ packageManager: "pnpm@10.30.3" }));
  writeFileSync(join(checkout, "pnpm-workspace.yaml"), "useNodeVersion: 24.18.0\n");
  function executable(name, body) {
    const target = join(bin, name);
    writeFileSync(target, `#!${process.execPath}\n${body}`);
    chmodSync(target, 0o755);
  }
  executable(
    "pnpm",
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0] === '-v') {
  if(process.env.PNPM_VERSION_FAILURE) process.exit(2);
  console.log(process.env.PNPM_TEST_VERSION ?? '10.30.3');
  process.exit(0);
}
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({command:'pnpm',args,cwd:process.cwd(),database:process.env.DATABASE_URL})+'\\n');
if(process.env.FAIL_COMMAND === args[0]) process.exit(17);
if(process.env.SIGNAL_COMMAND === args[0]) process.kill(process.pid, 'SIGTERM');
`,
  );
  executable(
    "npm",
    `require('node:fs').appendFileSync(process.env.COMMAND_LOG, JSON.stringify({command:'npm',args:process.argv.slice(2),cwd:process.cwd()})+'\\n'); process.exit(Number(process.env.NPM_TEST_EXIT ?? 0));`,
  );
  executable("git", `console.log(${JSON.stringify(join(main, ".git"))});`);
  const log = join(temporary, "commands.jsonl");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    COMMAND_LOG: log,
    DATABASE_URL: join(temporary, "outside.sqlite"),
  };
  delete env.NODE_TEST_CONTEXT;
  function commands() {
    return existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  }
  function setup(args = [], overrides = {}) {
    return run(process.execPath, [join(checkout, "infra/scripts/setup-worktree.mjs"), ...args], {
      cwd: temporary,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  }
  function helper(args = [], overrides = {}) {
    return run("bash", [join(checkout, "infra/scripts/pnpm-with-pinned-node.sh"), ...args], {
      cwd: temporary,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  }
  return { temporary, checkout, main, bin, env, commands, setup, helper };
}

test("worktree bootstrap preserves working files, uses a frozen install and migrates only its local database", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "apps/api/.env"), "existing=keep\n");
  mkdirSync(join(f.checkout, ".notes"));
  writeFileSync(join(f.checkout, ".notes/local.md"), "local notes");
  mkdirSync(join(f.main, ".notes"));
  mkdirSync(join(f.main, "lab/prototypes/shared"), { recursive: true });
  writeFileSync(join(f.main, "lab/prototypes/shared/prototype.txt"), "shared prototype");
  mkdirSync(join(f.checkout, "lab/prototypes/shared"), { recursive: true });
  writeFileSync(join(f.checkout, "lab/prototypes/shared/local.txt"), "keep prototype");
  writeFileSync(join(f.checkout, "lab/prototypes/README.md"), "tracked scaffolding");
  mkdirSync(join(f.main, "lab/prototypes/linked"));
  const result = await f.setup(["--with-playwright"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Worktree setup complete/);
  assert.deepEqual(
    f.commands().map((command) => command.args),
    [
      ["install", "--frozen-lockfile"],
      ["db:migrate"],
      ["--filter", "@unimatrix/web", "exec", "playwright", "install", "--with-deps", "chromium"],
    ],
  );
  assert.ok(f.commands().every((command) => command.cwd === f.checkout));
  assert.equal(f.commands()[1].database, join(f.checkout, "packages/db/local/unimatrix.sqlite"));
  assert.equal(f.commands()[0].database, f.env.DATABASE_URL);
  assert.equal(readFileSync(join(f.checkout, "apps/api/.env"), "utf8"), "existing=keep\n");
  assert.equal(readFileSync(join(f.checkout, "apps/web/.env"), "utf8"), "web=example\n");
  assert.equal(readFileSync(join(f.checkout, ".notes/local.md"), "utf8"), "local notes");
  assert.equal(
    readFileSync(join(f.checkout, "lab/prototypes/shared/local.txt"), "utf8"),
    "keep prototype",
  );
  assert.equal(
    readFileSync(join(f.checkout, "lab/prototypes/README.md"), "utf8"),
    "tracked scaffolding",
  );
  assert.equal(
    realpathSync(join(f.checkout, "lab/prototypes/linked")),
    join(f.main, "lab/prototypes/linked"),
  );
  assert.equal(existsSync(f.env.DATABASE_URL), false);
});

test("worktree bootstrap links missing notes and stops after install or migration failures", async (t) => {
  for (const command of ["install", "db:migrate"]) {
    const f = fixture(t);
    mkdirSync(join(f.main, ".notes"));
    writeFileSync(join(f.main, ".notes/owner.md"), "owner notes");
    const result = await f.setup(["--with-playwright"], { FAIL_COMMAND: command });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exited with code 17/);
    assert.doesNotMatch(result.stdout, /Worktree setup complete/);
    assert.equal(f.commands().length, command === "install" ? 1 : 2);
    if (command === "install") assert.equal(existsSync(join(f.checkout, "apps/web/.env")), false);
    else {
      assert.equal(lstatSync(join(f.checkout, ".notes")).isSymbolicLink(), true);
      assert.equal(readFileSync(join(f.checkout, ".notes/owner.md"), "utf8"), "owner notes");
    }
  }
});

test("worktree bootstrap rejects invalid options and propagates terminated children", async (t) => {
  const f = fixture(t);
  assert.equal((await f.setup(["--help"])).status, 0);
  assert.equal(f.commands().length, 0);
  assert.equal((await f.setup(["--invalid"])).status, 1);
  assert.equal(f.commands().length, 0);
  const terminated = await f.setup([], { SIGNAL_COMMAND: "install" });
  assert.equal(terminated.status, 1);
  assert.match(terminated.stderr, /signal SIGTERM/);
  assert.equal(f.commands().length, 1);
});

test("worktree bootstrap stops on a missing package manager or env template", async (t) => {
  const missingManager = fixture(t);
  rmSync(join(missingManager.bin, "pnpm"));
  const failedLaunch = await missingManager.setup([], { PATH: missingManager.bin });
  assert.equal(failedLaunch.status, 1);
  assert.match(failedLaunch.stderr, /Failed to start pnpm install/);
  assert.equal(missingManager.commands().length, 0);
  assert.equal(existsSync(join(missingManager.checkout, "apps/api/.env")), false);

  const missingTemplate = fixture(t);
  rmSync(join(missingTemplate.checkout, "apps/api/.env.example"));
  const failedBootstrap = await missingTemplate.setup();
  assert.equal(failedBootstrap.status, 1);
  assert.match(failedBootstrap.stderr, /example file apps\/api\/\.env\.example is missing/);
  assert.deepEqual(
    missingTemplate.commands().map((command) => command.args),
    [["install", "--frozen-lockfile"]],
  );
  assert.doesNotMatch(failedBootstrap.stdout, /Worktree setup complete/);
});

test("pinned helper reuses matching pnpm and preserves arguments and failures", async (t) => {
  const f = fixture(t);
  const args = ["exec", "node", "argument with spaces", "$(literal)", "quote's literal"];
  const result = await f.helper(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.commands(), [
    { command: "pnpm", args, cwd: f.checkout, database: f.env.DATABASE_URL },
  ]);
  assert.match(result.stderr, /workspace Node 24\.18\.0/);
  assert.equal((await f.helper(["install"], { FAIL_COMMAND: "install" })).status, 17);
  assert.equal((await f.helper()).status, 1);
});

test("pinned helper bootstraps only pnpm on mismatch or broken launcher and propagates npm failure", async (t) => {
  for (const overrides of [{ PNPM_TEST_VERSION: "9.0.0" }, { PNPM_VERSION_FAILURE: "1" }]) {
    const f = fixture(t);
    const result = await f.helper(["install", "--frozen-lockfile"], {
      ...overrides,
      NPM_TEST_EXIT: "19",
    });
    assert.equal(result.status, 19, result.stderr);
    const [command] = f.commands();
    assert.equal(command.command, "npm");
    assert.equal(command.args.includes("--package=pnpm@10.30.3"), true);
    assert.equal(
      command.args.some((argument) => argument.startsWith("--package=node@")),
      false,
    );
    assert.deepEqual(command.args.slice(-3), [f.checkout, "install", "--frozen-lockfile"]);
  }
});
