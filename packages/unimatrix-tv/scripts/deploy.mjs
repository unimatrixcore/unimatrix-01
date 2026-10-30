import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./package-plugin.mjs";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pkgRoot, "../..");

export function parseOptions(args) {
  const options = { host: "unimatrix-03", requests: false, check: false, skipBuild: false };
  for (const arg of args) {
    if (arg === "--requests") options.requests = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg.startsWith("--host=")) options.host = arg.slice(7);
    else throw new Error(`Unknown deployment option: ${arg}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(options.host)) throw new Error("Invalid SSH host.");
  return options;
}

export function readRelease(root, includeRequests) {
  const readManifest = (directory) =>
    JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const pluginDir = path.join(root, "dist/plugin");
  const plugin = readManifest(pluginDir);
  if (
    plugin.schema !== 1 ||
    plugin.guid !== "f6b0f02e-128b-4a57-b088-3e4b7b20e001" ||
    plugin.name !== "Unimatrix-TV" ||
    !/^\d+\.\d+\.\d+\.\d+$/.test(plugin.version) ||
    !/^[a-f0-9]{16}$/.test(plugin.revision)
  )
    throw new Error("Invalid plugin manifest.");
  const readFiles = (directory, manifest, allowed) => {
    const output = {};
    for (const [name, hash] of Object.entries(manifest.files)) {
      if (!allowed.has(name) || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error(`Unexpected release artifact: ${name}`);
      const file = path.join(directory, name);
      const fd = fs.openSync(file, "r");
      let bytes;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`Artifact must be a regular file: ${name}`);
        bytes = fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (sha256(bytes) !== hash) throw new Error(`Artifact checksum mismatch: ${name}`);
      output[name] = bytes.toString("base64");
    }
    return output;
  };
  const files = readFiles(pluginDir, plugin, new Set(["UnimatrixTV.dll", "meta.json", "logo.png"]));
  if (!files["UnimatrixTV.dll"] || !files["meta.json"] || !files["logo.png"])
    throw new Error("Incomplete plugin release.");
  const release = { plugin, pluginFiles: files, check: false };
  if (includeRequests) {
    const directory = path.join(root, "dist/requests");
    const requests = readManifest(directory);
    if (
      !requests.compatibility?.document?.sha256 ||
      !requests.compatibility?.imageId ||
      !requests.compatibility?.image ||
      !requests.files?.["seerr-document.js"]
    )
      throw new Error("Requests release needs a pinned image and document compatibility baseline.");
    release.requests = requests;
    release.requestsFiles = readFiles(
      directory,
      requests,
      new Set([
        "seerr.css",
        "seerr.js",
        "seerr-document.js",
        "request-pipeline.cjs",
        "released-only.cjs",
        "logo.png",
        "geist-mono.woff2",
        "geist-mono.LICENSE",
        "manrope.ttf",
        "manrope.LICENSE",
      ]),
    );
    for (const name of [
      "seerr.css",
      "seerr.js",
      "seerr-document.js",
      "request-pipeline.cjs",
      "released-only.cjs",
    ])
      if (!release.requestsFiles[name]) throw new Error(`Requests artifact missing: ${name}`);
  }
  return release;
}

export const remoteDeployment = String.raw`
import base64, hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request, uuid
sys.path.insert(0, '/srv/streaming/deployment')
from runtime import container, jf
ROOT = pathlib.Path('/srv/streaming')
release = json.loads(base64.b64decode(PAYLOAD))
state_root = ROOT / 'deployment/unimatrix-tv'
plugin_root = ROOT / 'config/jellyfin/data/plugins'
policy_root = ROOT / 'config/branding/release-policy'
theme_root = ROOT / 'config/branding/theme'
plugin = release['plugin']
plugin_name = plugin['name'] + '_' + plugin['version']
plugin_destination = plugin_root / plugin_name
jf_container = container('jellyfin')
services = [jf_container]
last_state = state_root / 'current.json'
previous_state = json.loads(last_state.read_text()) if last_state.exists() else {}
branding = jf('/System/Configuration/branding')
css_key = next((k for k in branding if k.lower() == 'customcss'), None)
previous_css = branding.get(css_key) if css_key else None
if previous_css and not any(marker in previous_css for marker in ['Unimatrix-TV', '--utv-', 'utv-']):
    raise RuntimeError('Custom CSS is not an identified Unimatrix-TV release; automatic replacement refused.')

def digest(data): return hashlib.sha256(data).hexdigest()
def inspect(name): return json.loads(subprocess.check_output(['docker', 'inspect', name], text=True))[0]
def fetch(port, path):
    with urllib.request.urlopen('http://127.0.0.1:' + str(port) + path, timeout=5) as response:
        return response.read()

requests_targets = {}
if 'requests' in release:
    request_release = release['requests']
    compatibility = request_release['compatibility']
    seerr_container = container('seerr')
    current = inspect(seerr_container)
    if current['Image'] != compatibility['imageId'] or current['Config']['Image'] != compatibility['image']:
        raise RuntimeError('Seerr image differs from the compiled document compatibility baseline.')
    document_mount = next((m for m in current['Mounts'] if m['Destination'] == compatibility['document']['mountTarget']), None)
    if document_mount is None or pathlib.Path(document_mount['Source']) != theme_root / 'seerr-document.js':
        raise RuntimeError('Seerr document is not mounted at the verified target.')
    valid_hashes = {compatibility['document']['sha256']}
    last_hash = previous_state.get('requests', {}).get('files', {}).get('seerr-document.js')
    if last_hash: valid_hashes.add(last_hash)
    if digest((theme_root / 'seerr-document.js').read_bytes()) not in valid_hashes:
        raise RuntimeError('Installed Seerr document differs from the approved baseline or last verified deployment.')
    for name in release['requestsFiles']:
        requests_targets[name] = (policy_root if name in ['request-pipeline.cjs', 'released-only.cjs'] else theme_root) / name
    services.append(seerr_container)

existing = []
for folder in plugin_root.iterdir():
    metadata = folder / 'meta.json'
    if not metadata.is_file(): continue
    try: identity = json.loads(metadata.read_text()).get('guid', '').replace('-', '').lower()
    except (ValueError, OSError): continue
    if identity == plugin['guid'].replace('-', '').lower(): existing.append(folder)
if plugin_destination.exists() and plugin_destination not in existing:
    raise RuntimeError('Plugin destination belongs to another installation.')

if release['check']:
    print(json.dumps({'preflight': 'passed', 'pluginVersion': plugin['version'], 'pluginRevision': plugin['revision'], 'requests': 'requests' in release, 'legacyCustomCss': bool(previous_css)}))
    sys.exit(0)

state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
backup = state_root / ('backup-' + uuid.uuid4().hex)
backup.mkdir(mode=0o700)
(backup / 'plugin').mkdir()
(backup / 'requests').mkdir()
(backup / 'branding.json').write_text(json.dumps(branding))
os.chmod(backup / 'branding.json', 0o600)
request_backups = {name: target.read_bytes() if target.exists() else None for name, target in requests_targets.items()}
for name, content in request_backups.items():
    if content is not None: (backup / 'requests' / name).write_bytes(content)
(backup / 'release.json').write_text(json.dumps(release['plugin']))
moved = []

def set_permissions(target, is_dir=False):
    try:
        stat = plugin_root.stat()
        os.chown(target, stat.st_uid, stat.st_gid)
    except OSError:
        pass
    try:
        target.chmod(0o755 if is_dir else 0o644)
    except OSError:
        pass

def write_in_place(target, content):
    target.parent.mkdir(parents=True, exist_ok=True)
    set_permissions(target.parent, is_dir=True)
    with target.open('wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    set_permissions(target, is_dir=False)

def restart(names):
    subprocess.run(['docker', 'restart', '--timeout', '20', *names], check=True, timeout=80, stdout=subprocess.DEVNULL)

def verify():
    status = json.loads(fetch(18096, '/UnimatrixTV/status'))
    if status.get('status') != 'active' or not status.get('assetsReady') or status.get('version') != plugin['version'] or status.get('revision') != plugin['revision']:
        raise RuntimeError('Jellyfin returned a different or incomplete plugin release.')
    if digest(fetch(18096, '/UnimatrixTV/presentation.css')) != plugin['assets']['presentation.css']:
        raise RuntimeError('Served stylesheet checksum differs from packaged assets.')
    index = fetch(18096, '/web/index.html').decode()
    if 'unimatrix-theme/' in index:
        raise RuntimeError('Native web index still uses legacy theme code.')
    if status.get('enabled'):
        if '/UnimatrixTV/unimatrix.js?v=' + plugin['revision'] not in index or ('unimatrix-tv-critical' in index) != bool(status.get('bootGate')):
            raise RuntimeError('Native web index is not using the configured packaged boot integration.')
    elif '/UnimatrixTV/unimatrix.js' in index:
        raise RuntimeError('Disabled plugin is still injected into the native index.')
    standard = fetch(18096, '/web/index.html?unimatrix=off').decode()
    if 'unimatrix-tv-critical' in standard or '/UnimatrixTV/unimatrix.js' in standard:
        raise RuntimeError('Standard-view recovery still has plugin boot code.')
    if 'requests' in release:
        if not json.loads(fetch(15055, '/api/v1/status')).get('version'):
            raise RuntimeError('Seerr status endpoint is not healthy.')
        if digest((theme_root / 'seerr-document.js').read_bytes()) != release['requests']['files']['seerr-document.js']:
            raise RuntimeError('Deployed Seerr document checksum differs from its manifest.')

try:
    for folder in existing:
        shutil.move(str(folder), str(backup / 'plugin' / folder.name))
        moved.append(folder)
    plugin_destination.mkdir(mode=0o755, exist_ok=True)
    set_permissions(plugin_destination, is_dir=True)
    for name, content in release['pluginFiles'].items():
        write_in_place(plugin_destination / name, base64.b64decode(content))
    metadata = json.loads((plugin_destination / 'meta.json').read_text())
    metadata['imagePath'] = '/config/data/plugins/' + plugin_name + '/logo.png'
    write_in_place(plugin_destination / 'meta.json', json.dumps(metadata).encode())
    write_in_place(plugin_destination / 'manifest.json', json.dumps(plugin).encode())
    for item in plugin_destination.rglob('*'):
        set_permissions(item, is_dir=item.is_dir())
    set_permissions(plugin_destination, is_dir=True)
    for name, target in requests_targets.items():
        write_in_place(target, base64.b64decode(release['requestsFiles'][name]))
    if previous_css:
        current_branding = jf('/System/Configuration/branding')
        current_branding[css_key] = ''
        jf('/System/Configuration/branding', current_branding, 'POST')
    restart(services)
    failure = None
    for attempt in range(30):
        try:
            verify()
            failure = None
            break
        except Exception as error:
            failure = error
            time.sleep(2)
    if failure: raise RuntimeError('Release health verification failed: ' + str(failure))
    write_in_place(last_state, json.dumps({'plugin': plugin, 'requests': release.get('requests', previous_state.get('requests')), 'backup': str(backup)}).encode())
    os.chmod(last_state, 0o600)
    print(json.dumps({'deployment': 'verified', 'pluginVersion': plugin['version'], 'revision': plugin['revision'], 'backup': str(backup), 'requests': 'requests' in release}))
except Exception as original_failure:
    rollback_errors = []
    try:
        if plugin_destination.exists(): shutil.move(str(plugin_destination), str(backup / 'failed-plugin'))
    except Exception: rollback_errors.append('new plugin removal')
    for folder in moved:
        try:
            shutil.move(str(backup / 'plugin' / folder.name), str(folder))
            set_permissions(folder, is_dir=True)
            for item in folder.rglob('*'):
                set_permissions(item, is_dir=item.is_dir())
        except Exception: rollback_errors.append('old plugin restore')
    for name, content in request_backups.items():
        try:
            target = requests_targets[name]
            if content is None:
                if target.exists(): target.unlink()
            else: write_in_place(target, content)
        except Exception: rollback_errors.append('Requests file restore: ' + name)
    try: restart(services)
    except Exception: rollback_errors.append('old services restart')
    if previous_css:
        restored = False
        for attempt in range(10):
            try:
                fetch(18096, '/health')
                current_branding = jf('/System/Configuration/branding')
                if current_branding.get(css_key) == '':
                    current_branding[css_key] = previous_css
                    jf('/System/Configuration/branding', current_branding, 'POST')
                restored = True
                break
            except Exception: time.sleep(2)
        if not restored: rollback_errors.append('legacy CSS restore; preserved in branding.json')
    print(json.dumps({'deployment': 'rollback_incomplete' if rollback_errors else 'rolled_back', 'backup': str(backup), 'rollbackErrors': rollback_errors}), file=sys.stderr)
    if rollback_errors: raise RuntimeError('Deployment failed; rollback needs attention at ' + str(backup)) from original_failure
    raise

`;

export function deploy(args = process.argv.slice(2), run = execFileSync, root = pkgRoot) {
  const options = parseOptions(args);
  if (!options.skipBuild)
    run(
      "bash",
      [
        path.join(repoRoot, "infra/scripts/pnpm-with-pinned-node.sh"),
        "--filter",
        "@unimatrix/tv",
        "build",
      ],
      { cwd: repoRoot, stdio: "inherit", timeout: 180_000 },
    );
  const release = readRelease(root, options.requests);
  release.check = options.check;
  const payload = Buffer.from(JSON.stringify(release)).toString("base64");
  const python = `PAYLOAD = '${payload}'\n${remoteDeployment}`;
  const output = run(
    "ssh",
    [
      "-F",
      path.join(os.homedir(), ".ssh/config"),
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      options.host,
      "sudo",
      "python3",
      "-",
    ],
    // Remote worst case: restart (80s) + verify (30 × 7s) + rollback restart (80s) + CSS restore (10 × 7s).
    { input: python, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 600_000 },
  );
  console.log(output.trim());
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    deploy();
  } catch (error) {
    console.error(`Deployment failed: ${error.message}`);
    process.exitCode = 1;
  }
}
