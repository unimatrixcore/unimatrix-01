#!/usr/bin/env node
import { lstat, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** Retain recent hash groups without traversing unrelated cache entries. */
export async function trimTurboCache(directory, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }

  const groups = new Map();
  let ignoredEntries = 0;
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    names = [];
  }

  for (const name of names) {
    const match = /^([a-f0-9]{16})(?:\.tar\.zst|-meta\.json|-manifest\.json)$/u.exec(name);
    if (!match) {
      ignoredEntries += 1;
      continue;
    }
    const filePath = join(directory, name);
    const stat = await lstat(filePath);
    if (!stat.isFile()) {
      ignoredEntries += 1;
      continue;
    }
    const group = groups.get(match[1]) ?? {
      hash: match[1],
      files: [],
      bytes: 0,
      modifiedAt: 0,
    };
    group.files.push(filePath);
    group.bytes += stat.size;
    group.modifiedAt = Math.max(group.modifiedAt, stat.mtimeMs);
    groups.set(match[1], group);
  }

  let bytesAfter = 0;
  let retainedEntries = 0;
  let removedEntries = 0;
  const entries = [...groups.values()].sort(
    (a, b) => b.modifiedAt - a.modifiedAt || a.hash.localeCompare(b.hash),
  );
  for (const entry of entries) {
    if (bytesAfter + entry.bytes <= maxBytes) {
      bytesAfter += entry.bytes;
      retainedEntries += 1;
      continue;
    }
    await Promise.all(entry.files.map((filePath) => unlink(filePath)));
    removedEntries += 1;
  }

  return {
    maxBytes,
    bytesBefore: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    bytesAfter,
    retainedEntries,
    removedEntries,
    ignoredEntries,
  };
}

async function main(args) {
  if (args.length !== 1 && args.length !== 3) {
    throw new Error("Usage: trim-turbo-cache.mjs <directory> [--max-bytes <integer>]");
  }
  if (args.length === 3 && (args[1] !== "--max-bytes" || !/^\d+$/u.test(args[2]))) {
    throw new Error("Usage: trim-turbo-cache.mjs <directory> [--max-bytes <integer>]");
  }
  const result = await trimTurboCache(resolve(args[0]), {
    maxBytes: args.length === 3 ? Number(args[2]) : DEFAULT_MAX_BYTES,
  });
  console.log(`trim-turbo-cache: ${JSON.stringify(result)}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`trim-turbo-cache: ${error.message}`);
    process.exitCode = 1;
  });
}
