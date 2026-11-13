import process from "node:process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(app, "../..");
const fixture = mkdtempSync(join(tmpdir(), "poker-lab-parity-"));
try {
  const tools = join(fixture, "dev_tools");
  mkdirSync(join(tools, "templates"), { recursive: true });
  cpSync(join(app, "public/static/js"), join(tools, "static/js"), { recursive: true });
  const controllerPath = join(tools, "static/js/app.js");
  const controller = readFileSync(controllerPath, "utf8");
  const boot = controller.match(/^window\.pokerOcrReady = init\(\)\.catch\([^\n]+\);$/gm);
  if (boot?.length !== 1) throw new Error("Expected one OCR startup boundary for legacy fixtures.");
  // The retained VM tests suppress startup and invoke controller behaviors themselves.
  // Keep their original suppression seam; browser tests exercise the real lifecycle.
  writeFileSync(
    controllerPath,
    controller.replace(
      boot[0],
      'init().catch(error => { showLoading(false); showToast(error.message, "error"); });',
    ),
  );
  cpSync(join(app, "src/collector"), join(tools, "collector_ui"), { recursive: true });
  cpSync(join(app, "test/upstream"), join(tools, "tests"), { recursive: true });
  cpSync(join(repo, "packages/poker/ocr-contract.json"), join(tools, "ocr_contract.json"));
  const script =
    '<script src="/static/ui/collector-ui.js"></script>\n<script src="/static/js/app.js"></script>';
  const html = readFileSync(join(app, "index.html"), "utf8").replace(
    '<script type="module" src="/src/main.ts"></script>',
    script,
  );
  writeFileSync(join(tools, "templates/poker_lab.html"), html);
  execFileSync(
    "pnpm",
    [
      "exec",
      "vite",
      "build",
      "--config",
      "vite.legacy-test.config.ts",
      "--outDir",
      join(tools, "static/ui"),
    ],
    { cwd: app, stdio: "inherit" },
  );
  const env = {
    ...process.env,
    UNIMATRIX_UI_ROOT: join(repo, "packages/ui"),
    NODE_PATH: join(app, "node_modules"),
  };
  const failures = [];
  for (const file of readdirSync(join(tools, "tests"))
    .filter((name) => name.endsWith(".cjs"))
    .sort()) {
    process.stdout.write(`Poker Lab source parity: ${file}\n`);
    try {
      const output = execFileSync(process.execPath, [join(tools, "tests", file)], {
        cwd: fixture,
        env,
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 32 * 1024 * 1024,
      });
      process.stdout.write(output);
    } catch (error) {
      failures.push(file);
      process.stderr.write(`${error.message.split("\n")[0]}\n`);
      const output = String(error.stdout || "") + String(error.stderr || "");
      process.stderr.write(
        output
          .split("\n")
          .filter((line) => line.length < 2000)
          .slice(-30)
          .join("\n") + "\n",
      );
    }
  }
  if (failures.length) throw new Error(`Source parity tests failed: ${failures.join(", ")}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
