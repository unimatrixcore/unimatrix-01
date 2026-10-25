import { SecretValue } from "@unimatrix/secrets/client";

import { parseEnvLine } from "../dokploy/env-line.js";

/** Trim assignment padding and decode the literal quoting emitted by encodeValue. */
function comparable(value: string): string | null {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("\\'", "'");
  }
  if (value.replaceAll("$$", "").includes("$")) return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed.replaceAll("$$", "$") : null;
    } catch {
      return null;
    }
  }
  return value
    .replace(/\s+#.*$/u, "")
    .trimEnd()
    .replaceAll("$$", "$");
}

function encodeValue(value: string): string {
  if (value === value.trim() && !/[#$'"\\]/u.test(value)) return value;
  return JSON.stringify(value).split("$").join("$$");
}

export interface EnvMergeResult {
  readonly env: SecretValue;
  readonly changed: readonly string[];
  readonly refused: readonly string[];
}

export function mergeSecretEnv(
  existing: SecretValue,
  resolved: ReadonlyMap<string, SecretValue>,
  overwrite: boolean,
): EnvMergeResult {
  const blob = existing.reveal();
  const lines = blob.split(/(?<=\n)/u);
  const changed: string[] = [];
  const refused: string[] = [];
  for (const [key, secret] of resolved) {
    const value = secret.reveal();
    const matches = lines.flatMap((line, index) =>
      parseEnvLine(line)?.key === key ? [index] : [],
    );
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
      value.trim().length === 0 ||
      /[\r\n\0]/u.test(value) ||
      value.includes("${{") ||
      matches.length > 1
    ) {
      refused.push(key);
      continue;
    }
    const index = matches[0];
    const entry = index === undefined ? null : parseEnvLine(lines[index] ?? "");
    if (entry !== null && comparable(entry.value) === value) continue;
    if (entry !== null && !overwrite) {
      refused.push(key);
      continue;
    }
    changed.push(key);
    const encoded = encodeValue(value);
    if (index === undefined) {
      const newline = blob.includes("\r\n") ? "\r\n" : "\n";
      if (lines.length > 0 && !lines.at(-1)?.endsWith("\n") && lines.at(-1) !== "")
        lines.push(newline);
      lines.push(`${key}=${encoded}${newline}`);
    } else {
      const raw = lines[index] ?? "";
      const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
      lines[index] = `${key}=${encoded}${ending}`;
    }
  }
  return { env: new SecretValue(lines.join("")), changed, refused };
}
