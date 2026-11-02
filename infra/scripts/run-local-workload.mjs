import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const markerName = "UNIMATRIX_LOCAL_WORKLOAD";
const signalStatuses = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

export const LOCAL_WORKLOAD_LOCK_DIRECTORY = `/tmp/unimatrix-local-workload-${process.getuid?.()}`;

export function parseCpuList(value) {
  const cpus = [];
  for (const part of value.trim().split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(part);
    if (!match) throw new Error("Cannot read the inherited CPU affinity.");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      last < first ||
      last - first > 65535
    )
      throw new Error("Cannot read the inherited CPU affinity.");
    for (let cpu = first; cpu <= last; cpu += 1) cpus.push(cpu);
  }
  return [...new Set(cpus)];
}

function processInfo(pid) {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = value
    .slice(value.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  return { parent: Number(fields[1]), nice: Number(fields[16]), started: fields[19] };
}

function affinity() {
  const match = /^Cpus_allowed_list:\s*(.+)$/mu.exec(readFileSync("/proc/self/status", "utf8"));
  if (!match) throw new Error("Cannot read the inherited CPU affinity.");
  return parseCpuList(match[1]);
}

function executable(name, env) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the remaining PATH entries before refusing an unbounded run.
    }
  }
  throw new Error(`Local workloads require ${name}; refusing an unbounded run.`);
}

function ownsActiveWorkload(encoded, lockPath) {
  if (!encoded) return false;
  try {
    const marker = JSON.parse(encoded);
    if (
      !Number.isSafeInteger(marker.pid) ||
      !Number.isSafeInteger(marker.fd) ||
      marker.pid <= 1 ||
      marker.fd < 0 ||
      !Array.isArray(marker.cpus) ||
      marker.cpus.length < 1 ||
      marker.cpus.length > 2
    )
      return false;
    let parent = processInfo(process.pid).parent;
    while (parent > 1 && parent !== marker.pid) parent = processInfo(parent).parent;
    if (parent !== marker.pid || processInfo(parent).started !== marker.started) return false;
    const expected = statSync(lockPath);
    const held = statSync(`/proc/${parent}/fd/${marker.fd}`);
    if (expected.dev !== held.dev || expected.ino !== held.ino) return false;
    const fdinfo = readFileSync(`/proc/${parent}/fdinfo/${marker.fd}`, "utf8");
    if (!/^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s/mu.test(fdinfo)) return false;
    const cpus = affinity();
    return cpus.length <= 2 && cpus.every((cpu) => marker.cpus.includes(cpu));
  } catch {
    return false;
  }
}

function lockFile(directory) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0)
    throw new Error("The local workload lock directory must be private and owned by this user.");
  const path = join(directory, "lock");
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const file = fstatSync(fd);
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) {
    closeSync(fd);
    throw new Error("The local workload lock must be a private file owned by this user.");
  }
  return { fd, path };
}

function completed(child) {
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolveResult(code ?? signalStatuses[signal] ?? 1);
    });
  });
}

function sendSignal(pid, signal, group) {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function markedProcesses(encoded) {
  const marker = Buffer.from(`${markerName}=${encoded}\0`);
  const owned = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (statSync(`/proc/${entry}`).uid !== process.getuid()) continue;
      const environment = readFileSync(`/proc/${entry}/environ`);
      const offset = environment.indexOf(marker);
      if (offset >= 0 && (offset === 0 || environment[offset - 1] === 0))
        owned.push({ pid: Number(entry), started: processInfo(entry).started });
    } catch {
      // Exited or inaccessible processes cannot be identified as this workload's children.
    }
  }
  return owned;
}

function signalMarked(encoded, signal) {
  for (const child of markedProcesses(encoded)) {
    try {
      if (processInfo(child.pid).started === child.started) sendSignal(child.pid, signal, false);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
}

async function cleanupGroup(pid, encoded) {
  sendSignal(pid, "SIGTERM", true);
  signalMarked(encoded, "SIGTERM");
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  sendSignal(pid, "SIGKILL", true);
  signalMarked(encoded, "SIGKILL");
}

export async function runLocalWorkload(
  command,
  args,
  { env = process.env, lockDirectory = LOCAL_WORKLOAD_LOCK_DIRECTORY } = {},
) {
  if (!command) throw new Error("Usage: run-local-workload.mjs -- <command> [args...]");
  const hosted = env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted";
  const isolatedBuild = env.UNIMATRIX_CONTAINER_BUILD === "1";
  const bypass = hosted || isolatedBuild;
  if (!bypass && process.platform !== "linux")
    throw new Error(
      "Local workloads require Linux CPU affinity and flock; use hosted CI on this platform.",
    );

  const boundedEnv = bypass
    ? env
    : {
        ...env,
        VITEST_MAX_WORKERS: "1",
        MSBUILDDISABLENODEREUSE: "1",
        DOTNET_CLI_USE_MSBUILD_SERVER: "0",
        UseSharedCompilation: "false",
      };
  const nested = !bypass && ownsActiveWorkload(env[markerName], join(lockDirectory, "lock"));
  let child;
  let lock;
  let group = false;
  let interrupted;
  let forceTimer;
  const handlers = Object.entries(signalStatuses).map(([signal, status]) => {
    const handler = () => {
      interrupted ??= status;
      if (!child?.pid) return;
      sendSignal(child.pid, signal, group);
      forceTimer ??= setTimeout(() => sendSignal(child.pid, "SIGKILL", group), 1000);
    };
    process.on(signal, handler);
    return [signal, handler];
  });
  try {
    if (bypass || nested) {
      child = spawn(command, args, { stdio: "inherit", env: boundedEnv });
      const status = await completed(child);
      return interrupted ?? status;
    }

    const flock = executable("flock", env);
    const taskset = executable("taskset", env);
    const nice = executable("nice", env);
    const cpus = affinity().slice(0, 2);
    lock = lockFile(lockDirectory);
    console.error("local-workload: waiting for the shared local validation slot");
    child = spawn(flock, ["--exclusive", "3"], {
      stdio: ["ignore", "inherit", "inherit", lock.fd],
      env: boundedEnv,
    });
    const acquired = await completed(child);
    if (interrupted || acquired !== 0) return interrupted ?? acquired;
    boundedEnv[markerName] = JSON.stringify({
      pid: process.pid,
      fd: lock.fd,
      started: processInfo(process.pid).started,
      cpus,
      token: randomUUID(),
    });
    console.error(`local-workload: running on CPUs ${cpus.join(",")} with one Vitest worker`);
    group = true;
    child = spawn(taskset, ["--cpu-list", cpus.join(","), nice, "-n", "10", command, ...args], {
      stdio: "inherit",
      env: boundedEnv,
      detached: true,
    });
    const status = await completed(child);
    return interrupted ?? status;
  } finally {
    if (group && child?.pid) await cleanupGroup(child.pid, boundedEnv[markerName]);
    clearTimeout(forceTimer);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (lock) closeSync(lock.fd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  try {
    process.exitCode = await runLocalWorkload(args[0], args.slice(1));
  } catch (error) {
    console.error(`local-workload: ${error.message}`);
    process.exitCode = 1;
  }
}
