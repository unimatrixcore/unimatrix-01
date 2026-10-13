import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

const requestsSrcDir = path.join(pkgRoot, 'requests');
const distRequestsDir = path.join(pkgRoot, 'dist/requests');

fs.mkdirSync(distRequestsDir, { recursive: true });

console.log('Testing release policy engine...');
execFileSync(process.execPath, [path.join(requestsSrcDir, 'released-only.test.cjs')], {
  stdio: 'inherit',
});

console.log('Packaging requests extension assets...');
const filesToCopy = [
  'seerr.css',
  'seerr.js',
  'seerr-document.js',
  'request-pipeline.cjs',
  'released-only.cjs',
];

for (const file of filesToCopy) {
  const src = path.join(requestsSrcDir, file);
  if (!fs.existsSync(src)) {
    throw new Error(`Required requests file not found: ${src}`);
  }
  fs.copyFileSync(src, path.join(distRequestsDir, file));
}

// Copy shared logo into requests dist
const logoSrc = path.join(pkgRoot, 'assets/logo.png');
if (fs.existsSync(logoSrc)) {
  fs.copyFileSync(logoSrc, path.join(distRequestsDir, 'logo.png'));
}

// Write requests plugin metadata
const meta = {
  id: 'unimatrix-requests-theme',
  name: 'Unimatrix-TV Requests Plugin',
  version: '1.0.0',
  description: 'Unimatrix design system, Apple TV discover layout, and release pipeline for Jellyseerr requests',
  target: 'Jellyseerr',
  files: filesToCopy,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(distRequestsDir, 'manifest.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log('Requests plugin built successfully:');
console.log(fs.readdirSync(distRequestsDir).join(', '));
