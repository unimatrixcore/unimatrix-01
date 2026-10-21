import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, "..");

const distDir = path.join(pkgRoot, "dist");
const distAssetsDir = path.join(distDir, "assets");

fs.rmSync(distAssetsDir, { recursive: true, force: true });
fs.mkdirSync(distAssetsDir, { recursive: true });

// 1. Build presentation.css
console.log("Building presentation.css...");
const elegantFin = fs
  .readFileSync(path.join(pkgRoot, "vendor/elegantfin.css"), "utf8")
  .replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])\s*;/g, "")
  .replace(/@font-face\s*\{[^}]*fonts\.gstatic\.com[^}]*\}/g, "");
const elegantFinJf12 = fs.readFileSync(path.join(pkgRoot, "vendor/elegantfin-jf12.css"), "utf8");
const unimatrixCss = fs.readFileSync(path.join(pkgRoot, "assets/unimatrix.css"), "utf8");
const uxRefinementCss = fs.readFileSync(path.join(pkgRoot, "assets/ux-refinement.css"), "utf8");
const detailCss = fs.readFileSync(path.join(pkgRoot, "assets/detail.css"), "utf8");
const bootGateCss = fs.readFileSync(path.join(pkgRoot, "assets/boot-gate.css"), "utf8");

const combinedCss = [
  "/* Unimatrix-TV Combined Presentation Stylesheet */",
  elegantFin,
  elegantFinJf12,
  unimatrixCss,
  uxRefinementCss,
  detailCss,
  bootGateCss,
].join("\n\n");

const parsedStyles = await esbuild.transform(combinedCss, { loader: "css", logLevel: "silent" });
if (parsedStyles.warnings.length)
  throw new Error(
    "Stylesheet validation failed: " +
      parsedStyles.warnings.map((warning) => warning.text).join("; "),
  );
fs.writeFileSync(path.join(distDir, "presentation.css"), parsedStyles.code, "utf8");
fs.writeFileSync(path.join(distDir, "critical.css"), bootGateCss, "utf8");
await esbuild.build({
  entryPoints: [path.join(pkgRoot, "src/bootstrap.ts")],
  outfile: path.join(distDir, "bootstrap.js"),
  bundle: true,
  format: "iife",
  target: ["es2022"],
  minify: true,
});

// 2. Build unimatrix.js via esbuild
console.log("Building unimatrix.js...");
await esbuild.build({
  entryPoints: [path.join(pkgRoot, "src/index.ts")],
  outfile: path.join(distDir, "unimatrix.js"),
  bundle: true,
  format: "iife",
  target: ["es2022"],
  sourcemap: true,
});

// 3. Copy static assets into dist/assets
console.log("Copying static assets...");
const assetFiles = [
  "logo.png",
  "geist-mono.woff2",
  "geist-mono.LICENSE",
  "manrope.ttf",
  "manrope.LICENSE",
];
for (const file of assetFiles) {
  const src = path.join(pkgRoot, "assets", file);
  if (!fs.existsSync(src)) throw new Error(`Required client asset is missing: ${file}`);
  fs.copyFileSync(src, path.join(distAssetsDir, file));
}

console.log("Client build complete.");
