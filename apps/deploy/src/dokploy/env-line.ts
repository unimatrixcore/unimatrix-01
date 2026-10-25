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
