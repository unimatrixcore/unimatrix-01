import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deploy, parseOptions, readRelease, remoteDeployment } from "./deploy.mjs";
import { packagePlugin, publicAssets } from "./package-plugin.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "utv-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dotnet/bin/Release/net10.0"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dotnet/UnimatrixTV.csproj"),
    "<Project><Version>1.2.3</Version></Project>",
  );
  fs.writeFileSync(
    path.join(root, "meta.json"),
    JSON.stringify({ guid: "f6b0f02e-128b-4a57-b088-3e4b7b20e001", targetAbi: "12.2.0.0" }),
  );
  for (const name of publicAssets) {
    const file = path.join(root, "dist", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${name}`);
  }
  const dll = path.join(root, "dotnet/bin/Release/net10.0/UnimatrixTV.dll");
  fs.writeFileSync(dll, "new plugin");
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(dll, future, future);
  packagePlugin(root);
  return root;
}

test("untrusted SSH host cannot become an option or shell command", () => {
  for (const host of ["-oProxyCommand=evil", "host; touch /tmp/evil", "host\nother", ""])
    assert.throws(() => parseOptions([`--host=${host}`]));
  assert.equal(parseOptions(["--host=unimatrix-03", "--requests", "--check"]).requests, true);
});

test("corrupted release artifact is rejected before SSH runs", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "dist/plugin/UnimatrixTV.dll"), "changed");
  let calls = 0;
  assert.throws(
    () =>
      deploy(
        ["--skip-build", "--check"],
        () => {
          calls++;
        },
        root,
      ),
    /checksum mismatch/,
  );
  assert.equal(calls, 0);
});

test("asset changes require a fresh DLL build", (t) => {
  const root = fixture(t);
  const asset = path.join(root, "dist/critical.css");
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(asset, future, future);
  assert.throws(() => packagePlugin(root), /changed after the DLL build/);
});

test("deployment process errors propagate instead of reporting success", (t) => {
  const root = fixture(t);
  assert.throws(
    () =>
      deploy(
        ["--skip-build"],
        () => {
          throw new Error("remote health check failed");
        },
        root,
      ),
    /health check failed/,
  );
});

test("SSH uses argument vectors and data-only payload", (t) => {
  const root = fixture(t);
  let argumentsSeen;
  deploy(
    ["--skip-build", "--check"],
    (command, args, options) => {
      assert.equal(command, "ssh");
      assert.equal(args.at(-3), "sudo");
      assert.equal(args.at(-2), "python3");
      assert.equal(args.at(-1), "-");
      argumentsSeen = options.input;
      return '{"preflight":"passed"}';
    },
    root,
  );
  const encoded = /PAYLOAD = '([^']*)'/.exec(argumentsSeen)?.[1];
  assert.equal(JSON.parse(Buffer.from(encoded, "base64").toString()).check, true);
});

for (const recoveryWorks of [true, false]) {
  test(`failed live health restores files before restarting; recovery ${recoveryWorks ? "works" : "fails"}`, (t) => {
    const root = fixture(t);
    const release = readRelease(root, false);
    const python = `
import base64, contextlib, io, json, pathlib, sys, types, urllib.error, urllib.request
root = pathlib.Path(${JSON.stringify(root)}) / 'remote'
plugins = root / 'config/jellyfin/data/plugins'
old = plugins / 'Unimatrix TV_1.0.0.0'
old.mkdir(parents=True)
(old / 'meta.json').write_text(json.dumps({'guid': '${release.plugin.guid}'}))
(old / 'UnimatrixTV.dll').write_bytes(b'old plugin')
(root / 'config/branding/theme').mkdir(parents=True)
branding = {'CustomCss': 'Unimatrix-TV old CSS'}
state = {'restarts': 0, 'up': True, 'premature_restore': False}
def jf(path, data=None, method=None):
    if data is not None:
        if data['CustomCss'] and not state['up']: state['premature_restore'] = True
        if not state['up']: raise RuntimeError('API offline')
        branding.update(data)
    if not state['up']: raise RuntimeError('API offline')
    return dict(branding)
sys.modules['runtime'] = types.SimpleNamespace(container=lambda name: name, jf=jf)
import subprocess, time
original_run = subprocess.run
original_sleep = time.sleep
original_urlopen = urllib.request.urlopen
def run(*args, **kwargs):
    assert old.exists() if state['restarts'] else not old.exists()
    state['restarts'] += 1
    state['up'] = state['restarts'] > 1 and ${recoveryWorks ? "True" : "False"}
    return types.SimpleNamespace(returncode=0)
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self): return b'Healthy'
def urlopen(*args, **kwargs):
    if not state['up']: raise urllib.error.URLError('service unavailable')
    return Response()
subprocess.run = run
time.sleep = lambda *args: None
urllib.request.urlopen = urlopen
payload = ${JSON.stringify(Buffer.from(JSON.stringify(release)).toString("base64"))}
source = ${JSON.stringify(remoteDeployment)}.replace("ROOT = pathlib.Path('/srv/streaming')", 'ROOT = pathlib.Path(' + repr(str(root)) + ')')
output = io.StringIO()
try:
    with contextlib.redirect_stderr(output): exec(source, {'PAYLOAD': payload})
except Exception: pass
else: raise AssertionError('Unhealthy deployment was reported successful')
assert state['restarts'] == 2, state
assert not state['premature_restore'], state
assert (old / 'UnimatrixTV.dll').read_bytes() == b'old plugin'
assert not (plugins / 'Unimatrix-TV_1.2.3.0').exists()
assert not (root / 'deployment/unimatrix-tv/current.json').exists()
backups = list((root / 'deployment/unimatrix-tv').glob('backup-*'))
assert json.loads((backups[0] / 'branding.json').read_text())['CustomCss'] == 'Unimatrix-TV old CSS'
if ${recoveryWorks ? "True" : "False"}:
    assert branding['CustomCss'] == 'Unimatrix-TV old CSS'
    assert 'rolled_back' in output.getvalue()
else:
    assert 'rollback_incomplete' in output.getvalue()
print('Rollback failure simulation passed')
`;
    assert.match(
      execFileSync("python3", ["-"], { input: python, encoding: "utf8" }),
      /simulation passed/,
    );
  });
}
