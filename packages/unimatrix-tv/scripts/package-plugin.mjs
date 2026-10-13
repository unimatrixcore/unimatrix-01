import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

const pluginDistDir = path.join(pkgRoot, 'dist/plugin');
fs.mkdirSync(pluginDistDir, { recursive: true });

// Copy DLL
const dllSrc = path.join(pkgRoot, 'dotnet/bin/Release/net10.0/UnimatrixTV.dll');
if (fs.existsSync(dllSrc)) {
  fs.copyFileSync(dllSrc, path.join(pluginDistDir, 'UnimatrixTV.dll'));
} else {
  console.error('DLL not found: ' + dllSrc);
  process.exit(1);
}

// Copy meta.json
fs.copyFileSync(path.join(pkgRoot, 'meta.json'), path.join(pluginDistDir, 'meta.json'));

// Copy logo.png
const logoSrc = path.join(pkgRoot, 'assets/logo.png');
if (fs.existsSync(logoSrc)) {
  fs.copyFileSync(logoSrc, path.join(pluginDistDir, 'logo.png'));
}

console.log('Plugin packaged successfully in dist/plugin:');
console.log(fs.readdirSync(pluginDistDir).join(', '));
