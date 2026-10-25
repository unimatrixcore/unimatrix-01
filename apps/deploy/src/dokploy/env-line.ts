export interface EnvLine {
  readonly key: string;
  readonly value: string;
}

export function parseEnvLine(raw: string): EnvLine | null {
  const line = raw.trim();
  const separator = line.indexOf("=");
  if (line.startsWith("#") || separator < 1) return null;
  const key = line.slice(0, separator).trim();
  if (key.length === 0) return null;
  return { key, value: line.slice(separator + 1).trim() };
}

/** A quoted assignment must close on this physical line; only a comment may follow it. */
export function readEnvValueToken(value: string): string | null {
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return value.replace(/\s+#.*$/u, "").trimEnd();
  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      index++;
    } else if (character === quote) {
      const rest = value.slice(index + 1).trim();
      return rest.length === 0 || rest.startsWith("#") ? value.slice(0, index + 1) : null;
    }
  }
  return null;
}

/** Apply refuses syntax this physical-line parser cannot safely identify as one assignment. */
export function isSupportedEnvBlob(env: string): boolean {
  for (const raw of env.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (/^export\s/u.test(line) || /[\r\0]/u.test(line)) return false;
    const entry = parseEnvLine(line);
    if (entry === null || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.key)) return false;
    if (readEnvValueToken(entry.value) === null) return false;
  }
  return true;
}
