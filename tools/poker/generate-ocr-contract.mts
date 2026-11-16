import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pokerOcrValueContract } from "../../packages/shared/src/schemas/poker-ocr-values.ts";

const write = process.argv.includes("--write");
if (process.argv.some((arg, index) => index > 1 && !["--write", "--check"].includes(arg)))
  throw new Error("Usage: generate-ocr-contract.mts --write|--check");
const root = new URL("../../", import.meta.url);
const json = JSON.stringify(pokerOcrValueContract, null, 2) + "\n";
const digest = createHash("sha256").update(json).digest("hex");
for (const relative of [
  "packages/poker/ocr-contract.json",
  "tools/poker/dev_tools/ocr_contract.json",
]) {
  const path = new URL(relative, root);
  if (write) await writeFile(path, json);
  else if ((await readFile(path, "utf8")) !== json)
    throw new Error(`Generated OCR contract is stale: ${relative}`);
}
const path = new URL("packages/poker/src/contract.ts", root);
const existing = await readFile(path, "utf8");
const updated = existing.replace(/(pokerOcrContractSha256\s*=\s*)"[a-f0-9]{64}"/, `$1"${digest}"`);
if (!updated.includes(digest)) throw new Error("Missing generated contract digest export");
if (write) await writeFile(path, updated);
else if (updated !== existing)
  throw new Error(`Generated contract digest is stale: ${fileURLToPath(path)}`);
console.log(`OCR contract v${pokerOcrValueContract.version}: ${digest}`);
