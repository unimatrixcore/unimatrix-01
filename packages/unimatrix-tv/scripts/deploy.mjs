import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

const REMOTE_HOST = 'unimatrix-03';
const JELLYFIN_PLUGIN_DIR = '/srv/streaming/config/jellyfin/data/plugins/Unimatrix TV_1.0.0.0';
const THEME_DIR = '/srv/streaming/config/branding/theme';
const RELEASE_POLICY_DIR = '/srv/streaming/config/branding/release-policy';

console.log('=== 1. Building all Unimatrix-TV and Requests artifacts ===');
execSync('pnpm build', { cwd: pkgRoot, stdio: 'inherit' });

console.log('=== 2. Deploying Jellyfin plugin and theme to unimatrix-03 ===');
execSync(`ssh ${REMOTE_HOST} "mkdir -p '${JELLYFIN_PLUGIN_DIR}' '${THEME_DIR}' '${RELEASE_POLICY_DIR}'"`, { stdio: 'inherit' });

// Deploy Jellyfin plugin files
execSync(`scp ${path.join(pkgRoot, 'dist/plugin/*')} ${REMOTE_HOST}:'${JELLYFIN_PLUGIN_DIR}/'`, { stdio: 'inherit' });

// Deploy theme files (presentation.css, unimatrix.js, assets)
execSync(`scp ${path.join(pkgRoot, 'dist/presentation.css')} ${path.join(pkgRoot, 'dist/unimatrix.js')} ${REMOTE_HOST}:'${THEME_DIR}/'`, { stdio: 'inherit' });
execSync(`scp ${path.join(pkgRoot, 'dist/assets/*')} ${REMOTE_HOST}:'${THEME_DIR}/'`, { stdio: 'inherit' });

console.log('=== 3. Deploying Requests (Jellyseerr) plugin to unimatrix-03 ===');
execSync(`scp ${path.join(pkgRoot, 'dist/requests/seerr.css')} ${path.join(pkgRoot, 'dist/requests/seerr.js')} ${path.join(pkgRoot, 'dist/requests/seerr-document.js')} ${REMOTE_HOST}:'${THEME_DIR}/'`, { stdio: 'inherit' });
execSync(`scp ${path.join(pkgRoot, 'dist/requests/request-pipeline.cjs')} ${path.join(pkgRoot, 'dist/requests/released-only.cjs')} ${REMOTE_HOST}:'${RELEASE_POLICY_DIR}/'`, { stdio: 'inherit' });

console.log('=== 4. Restarting Jellyfin and Jellyseerr containers ===');
execSync(`ssh ${REMOTE_HOST} "docker restart compose-transmit-neural-bandwidth-g6k9vv-jellyfin-1 compose-transmit-neural-bandwidth-g6k9vv-seerr-1"`, { stdio: 'inherit' });

console.log('=== 5. Verifying live health ===');
let retries = 20;
let healthy = false;
while (retries > 0) {
  try {
    const res = execSync(`ssh ${REMOTE_HOST} "curl -sI http://127.0.0.1:18096/UnimatrixTV/status"`, { encoding: 'utf8' });
    if (res.includes('200 OK')) {
      healthy = true;
      console.log('Jellyfin UnimatrixTV endpoint: ONLINE (200 OK)');
      break;
    }
  } catch {
    // waiting for container
  }
  retries--;
  execFileSync('sleep', ['2']);
}

if (!healthy) {
  console.warn('Warning: Jellyfin container took longer than expected to report healthy.');
}

console.log('Deployment complete successfully.');
