#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "unimatrixcore/unimatrix-01";
const endpoint = `https://api.github.com/repos/${repository}/rules/branches/main`;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function imageCheckContexts(root = repoRoot) {
  const apps = join(root, "apps");
  const contexts = readdirSync(apps)
    .filter((app) => {
      try {
        return statSync(join(apps, app, "Dockerfile")).isFile();
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
      }
    })
    .sort()
    .map((app) => `Images (${app})`);
  if (contexts.length === 0)
    throw new Error("No apps/*/Dockerfile found; refusing an empty check.");
  return contexts;
}

export function requiredContexts(rules) {
  if (!Array.isArray(rules)) throw new Error("GitHub rules response must be an array.");
  const contexts = [];
  for (const rule of rules) {
    if (rule === null || typeof rule !== "object" || typeof rule.type !== "string") {
      throw new Error("GitHub rules response contains an invalid rule.");
    }
    if (rule.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) throw new Error("GitHub required status checks must be an array.");
    for (const check of checks) {
      if (
        check === null ||
        typeof check !== "object" ||
        typeof check.context !== "string" ||
        !check.context.trim()
      ) {
        throw new Error("GitHub required status checks contain an invalid context.");
      }
      contexts.push(check.context);
    }
  }
  return contexts;
}

export async function readRequiredContexts(fetchImpl = fetch) {
  const contexts = new Set();
  // Query the upstream repository even on fork PRs: the merge target's policy is the gate.
  for (let page = 1; page <= 100; page += 1) {
    const response = await fetchImpl(`${endpoint}?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "unimatrix-required-image-checks",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200) {
      throw new Error(
        `GitHub branch rules returned HTTP ${response.status}; cannot verify required checks.`,
      );
    }
    let rules;
    try {
      rules = await response.json();
    } catch {
      throw new Error("GitHub branch rules did not return valid JSON.");
    }
    for (const context of requiredContexts(rules)) contexts.add(context);
    if (rules.length < 100) return contexts;
  }
  throw new Error(
    "GitHub branch rules exceeded the pagination limit; cannot verify required checks.",
  );
}

export async function checkRequiredImageChecks({ root = repoRoot, fetchImpl = fetch } = {}) {
  const expected = imageCheckContexts(root);
  const required = await readRequiredContexts(fetchImpl);
  const missing = expected.filter((context) => !required.has(context));
  if (missing.length > 0) {
    throw new Error(
      `Add these exact required status check contexts to the active rules for ${repository} main:\n` +
        missing.map((context) => `  ${context}`).join("\n"),
    );
  }
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const contexts = await checkRequiredImageChecks();
    console.log(
      `check-required-image-checks: OK (${contexts.length} image checks required on main).`,
    );
  } catch (error) {
    console.error(`check-required-image-checks: FAIL\n${error.message}`);
    process.exitCode = 1;
  }
}
