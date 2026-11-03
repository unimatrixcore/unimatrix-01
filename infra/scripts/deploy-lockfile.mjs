import { posix } from "node:path";

function scalar(value) {
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(value)) throw new Error("Unsupported lockfile scalar.");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) return JSON.parse(value);
  if (!value || /^[&*!>|[{]/u.test(value) || /\s#/u.test(value))
    throw new Error("Unsupported lockfile scalar.");
  return value;
}

function blocks(lines, indent) {
  const result = new Map();
  let entry;
  for (const line of lines) {
    if (line.includes("\t")) throw new Error("Unsupported lockfile indentation.");
    const spaces = line.length - line.trimStart().length;
    if (spaces < indent) throw new Error("Invalid lockfile indentation.");
    if (spaces > indent) {
      if (!entry || entry.value) throw new Error("Invalid lockfile mapping.");
      entry.lines.push(line);
      continue;
    }
    const match = /^(.*?):(?: (.*))?$/u.exec(line.slice(indent));
    if (!match) throw new Error("Unsupported lockfile mapping.");
    const key = scalar(match[1]);
    if (typeof key !== "string" || result.has(key)) throw new Error("Duplicate lockfile key.");
    entry = { value: match[2] ?? "", lines: [] };
    result.set(key, entry);
  }
  return result;
}

function mapping(entry, indent) {
  if (!entry || (entry.value && entry.value !== "{}"))
    throw new Error("Unsupported lockfile mapping.");
  return blocks(entry.lines, indent);
}

function canonical(entries) {
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

function opaque(entry) {
  return [entry.value, entry.lines.map((line) => line.trimEnd())];
}

/**
 * Reads pnpm's canonical v9 block format without installing dependencies in release jobs.
 * Unsupported dependency forms throw so the planner can select conservatively.
 */
export function deploymentLockfileInputs(text, workspacePaths, excludeDependency = () => false) {
  const lines = text
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"));
  const top = blocks(lines, 0);
  if (scalar(top.get("lockfileVersion")?.value ?? "") !== "9.0")
    throw new Error("Unsupported lockfile version.");
  const importers = mapping(top.get("importers"), 2);
  const packages = mapping(top.get("packages"), 2);
  const snapshots = mapping(top.get("snapshots"), 2);
  const importerInputs = new Map();
  const packageInputs = new Map();
  const snapshotInputs = new Map();

  function external(name, version) {
    const id = `${name}@${version}`;
    if (snapshotInputs.has(id)) return;
    const snapshot = snapshots.get(id);
    const packageId = `${name}@${version.split("(", 1)[0]}`;
    const metadata = packages.get(packageId);
    if (!snapshot || !metadata || !/^\d+\.\d+\.\d+(?:[-+.(]|$)/u.test(version))
      throw new Error("Unsupported or missing lockfile dependency.");
    snapshotInputs.set(id, opaque(snapshot));
    packageInputs.set(packageId, opaque(metadata));
    for (const [field, entry] of mapping(snapshot, 4)) {
      if (field !== "dependencies" && field !== "optionalDependencies") continue;
      for (const [dependency, resolution] of mapping(entry, 6)) {
        if (resolution.lines.length) throw new Error("Unsupported snapshot dependency.");
        external(dependency, scalar(resolution.value));
      }
    }
  }

  function importer(path) {
    if (importerInputs.has(path)) return;
    const entry = importers.get(path);
    if (!entry) throw new Error("Missing lockfile importer.");
    const fields = mapping(entry, 4);
    const input = new Map();
    importerInputs.set(path, input);
    for (const [field, dependencies] of fields) {
      if (!["dependencies", "devDependencies", "optionalDependencies"].includes(field))
        throw new Error("Unsupported lockfile importer field.");
      const retained = new Map();
      input.set(field, retained);
      for (const [name, resolution] of mapping(dependencies, 6)) {
        if (excludeDependency(name, field)) continue;
        const attributes = mapping(resolution, 8);
        if (
          !attributes.has("specifier") ||
          !attributes.has("version") ||
          attributes.size !== 2 ||
          [...attributes.values()].some((attribute) => attribute.lines.length)
        )
          throw new Error("Unsupported importer resolution.");
        const specifier = scalar(attributes.get("specifier").value);
        const version = scalar(attributes.get("version").value);
        retained.set(name, { specifier, version });
        if (version.startsWith("link:")) {
          const target = posix.normalize(posix.join(path, version.slice(5)));
          if (target.startsWith("../") || posix.isAbsolute(target))
            throw new Error("Unsupported workspace link.");
          importer(target);
        } else external(name, version);
      }
      if (!retained.size) input.delete(field);
    }
  }

  for (const path of workspacePaths) importer(path);
  return {
    globals: canonical(
      [...top]
        .filter(([key]) => !["importers", "packages", "snapshots"].includes(key))
        .map(([key, entry]) => [key, opaque(entry)]),
    ),
    importers: canonical(
      [...importerInputs].map(([path, fields]) => [
        path,
        canonical([...fields].map(([field, dependencies]) => [field, canonical(dependencies)])),
      ]),
    ),
    packages: canonical(packageInputs),
    snapshots: canonical(snapshotInputs),
  };
}
