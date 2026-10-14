import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(pkgRoot, "requests");
const output = path.join(pkgRoot, "dist/requests");
const runtimeFiles = [
  "seerr.css",
  "seerr.js",
  "seerr-document.js",
  "request-pipeline.cjs",
  "released-only.cjs",
];
const sharedFiles = ["logo.png", "geist-mono.woff2", "geist-mono.LICENSE"];
const contents = new Map();
for (const name of runtimeFiles) contents.set(name, fs.readFileSync(path.join(source, name)));
for (const name of sharedFiles)
  contents.set(name, fs.readFileSync(path.join(pkgRoot, "assets", name)));

execFileSync(process.execPath, [path.join(source, "run-tests.cjs")], { stdio: "inherit" });
for (const name of runtimeFiles.filter((name) => /\.(?:cjs|js)$/.test(name))) {
  execFileSync(process.execPath, ["--check", path.join(source, name)], { stdio: "inherit" });
}
const revision = createHash("sha256")
  .update(contents.get("seerr.css"))
  .update(contents.get("seerr.js"))
  .digest("hex")
  .slice(0, 12);
const documentSource = contents.get("seerr-document.js").toString();
for (const name of ["seerr.css", "seerr.js"]) {
  if (!documentSource.includes(`/unimatrix-theme/${name}?v=`))
    throw new Error(`Missing document injection for ${name}`);
}
contents.set(
  "seerr-document.js",
  Buffer.from(
    documentSource.replace(
      /\/unimatrix-theme\/(seerr\.(?:css|js))\?v=[a-f0-9]+/g,
      (_, name) => `/unimatrix-theme/${name}?v=${revision}`,
    ),
  ),
);
const css = contents.get("seerr.css").toString();
for (const match of css.matchAll(/url\(['"]?(\/unimatrix-theme\/[^'"\s)]+)['"]?\)/g)) {
  const name = path.basename(match[1]);
  if (!contents.has(name))
    throw new Error(`Requests stylesheet references an unpackaged asset: ${name}`);
}
const files = Object.fromEntries(
  Array.from(contents, ([name, value]) => [name, createHash("sha256").update(value).digest("hex")]),
);
const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
const manifest = {
  id: "unimatrix-requests-theme",
  name: "Unimatrix-TV Requests",
  version,
  revision,
  target: "Seerr",
  files,
  builtAt: new Date().toISOString(),
  compatibility: {
    image:
      "ghcr.io/seerr-team/seerr@sha256:27602401178d54f1964442287b9f23f67a3fa2252645ee8065839ea1c3f69e45",
    imageId: "sha256:c1673c6c7835e21540cacbf517abb7c4a80d2893b3484bec1b1a11212ac247fb",
    document: {
      sha256: "19360b4e5d1801696fee87879e9b071df53064fadf846510762ba0430b1db283",
      mountTarget: "/app/.next/server/chunks/ssr/[root-of-the-server]__0_by504._.js",
    },
  },
};
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const [name, value] of contents) fs.writeFileSync(path.join(output, name), value);
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Requests assets packaged (${revision}); ${contents.size} files, all runtime suites passed.`,
);
