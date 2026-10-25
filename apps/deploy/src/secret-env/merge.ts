import { SecretValue } from "@unimatrix/secrets/client";

import { parseEnvLine } from "../dokploy/env-line.js";

/** Comparison trims assignment padding and removes one matching quote pair; it never expands references. */
function comparable(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
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
    if (value.trim().length === 0 || /[\r\n]/u.test(value) || matches.length > 1) {
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
    if (index === undefined) {
      const newline = blob.includes("\r\n") ? "\r\n" : "\n";
      if (lines.length > 0 && !lines.at(-1)?.endsWith("\n") && lines.at(-1) !== "")
        lines.push(newline);
      lines.push(`${key}=${value}${newline}`);
    } else {
      const raw = lines[index] ?? "";
      const ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
      lines[index] = `${key}=${value}${ending}`;
    }
  }
  return { env: new SecretValue(lines.join("")), changed, refused };
}
