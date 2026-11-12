import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const args of [
  ["fmt", "--all", "--check"],
  ["test", "-p", "poker-native", "--locked"],
  ["check", "--workspace", "--locked"],
]) {
  const result = spawnSync("cargo", args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
