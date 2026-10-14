import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = "dotnet/Tests/UnimatrixTV.ServerTests.csproj";
execFileSync("dotnet", ["build", project, "-c", "Release"], {
  cwd: root,
  stdio: "inherit",
});
const runtime =
  process.env.UTV_DOTNET_RUNTIME ??
  (fs.existsSync("/tmp/utv-runtime/dotnet") ? "/tmp/utv-runtime/dotnet" : "dotnet");
const env = { ...process.env };
if (runtime.includes("utv-runtime") && !env.DOTNET_ROOT) {
  env.DOTNET_ROOT = path.dirname(runtime);
}
execFileSync(runtime, ["dotnet/Tests/bin/Release/net10.0/UnimatrixTV.ServerTests.dll"], {
  cwd: root,
  stdio: "inherit",
  env,
});
