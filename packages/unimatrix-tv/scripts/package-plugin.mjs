import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const publicAssets = [
  "presentation.css",
  "unimatrix.js",
  "critical.css",
  "bootstrap.js",
  "assets/logo.png",
  "assets/geist-mono.woff2",
  "assets/manrope.ttf",
  "assets/favicon.ico",
];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function packagePlugin(root = pkgRoot) {
  const dll = path.join(root, "dotnet/bin/Release/net10.0/UnimatrixTV.dll");
  const project = fs.readFileSync(path.join(root, "dotnet/UnimatrixTV.csproj"), "utf8");
  const version = /<Version>([^<]+)<\/Version>/.exec(project)?.[1];
  if (!version || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Plugin project needs an explicit numeric version.");
  const assets = publicAssets.filter((name) => fs.existsSync(path.join(root, "dist", name)));
  for (const name of publicAssets.slice(0, 6)) {
    if (!assets.includes(name)) throw new Error(`Required client asset missing: ${name}`);
  }
  if (!fs.statSync(dll).isFile()) throw new Error("Compiled plugin DLL is missing.");
  for (const name of assets) {
    if (fs.statSync(path.join(root, "dist", name)).mtimeMs > fs.statSync(dll).mtimeMs) {
      throw new Error(
        "Client assets changed after the DLL build. Rebuild the plugin before packaging.",
      );
    }
  }
  const meta = JSON.parse(fs.readFileSync(path.join(root, "meta.json"), "utf8"));
  if (meta.guid !== "f6b0f02e-128b-4a57-b088-3e4b7b20e001")
    throw new Error("Unexpected plugin identity.");
  Object.assign(meta, {
    name: "Unimatrix-TV",
    version: `${version}.0`,
    status: "Active",
    autoUpdate: false,
    imagePath: "logo.png",
  });
  const dest = path.join(root, "dist/plugin");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(dll, path.join(dest, "UnimatrixTV.dll"));
  fs.copyFileSync(path.join(root, "dist/assets/logo.png"), path.join(dest, "logo.png"));
  fs.writeFileSync(path.join(dest, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const assetHashes = Object.fromEntries(
    assets.map((name) => [
      path.basename(name),
      sha256(fs.readFileSync(path.join(root, "dist", name))),
    ]),
  );
  const revision = sha256(
    Object.keys(assetHashes)
      .sort()
      .map((name) => `${name}"${assetHashes[name]}"`)
      .join("|"),
  ).slice(0, 16);
  const manifest = {
    schema: 1,
    guid: meta.guid,
    name: meta.name,
    version: meta.version,
    targetAbi: meta.targetAbi,
    revision,
    files: Object.fromEntries(
      ["UnimatrixTV.dll", "meta.json", "logo.png"].map((name) => [
        name,
        sha256(fs.readFileSync(path.join(dest, name))),
      ]),
    ),
    assets: assetHashes,
  };
  fs.writeFileSync(path.join(dest, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Packaged ${meta.name} ${meta.version}, revision ${revision}`);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  packagePlugin();
