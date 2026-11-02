#!/usr/bin/env node
//
// A coverage floor must stay near what the workspace measures.
//
// The floors are a ratchet: each is the measured figure rounded down, raised when
// a gap is genuinely closed. Nothing keeps them there. Coverage rises as tests are
// added, the floor does not follow, and the gap becomes slack that a real
// regression can hide inside — silently, because the gate is still green.
//
// It happened: `apps/api` gated at 85 line / 84 functions while measuring
// 94.54 / 91.98 over 121 tests. Deleting the whole of the user-data module's
// function coverage would still have cleared 85.
//
// The slack allowance is not zero, deliberately. V8 re-attributes functions
// between Node majors — `packages/db/AGENTS.md` and `apps/api/AGENTS.md` both
// record the 22 to 24 bump moving figures by under a point over an identical
// tree — so a floor pinned to the exact measurement turns the next runtime bump
// into a red required check for a reason that is not a regression.
//
// Reads `coverage/coverage-summary.json`, which exists because
// `packages/config-vitest` requests the `json-summary` reporter. Run it after the
// tests; it asserts on their artifacts rather than re-running them. Selected
// tests run fresh, and a missing expected summary fails the check.
//
// `apps/api` is not covered here. It runs the Node test runner rather than vitest
// and emits no such summary, so its floors are asserted by the
// `--test-coverage-lines`/`--test-coverage-functions` flags in its own
// `package.json` and read from its test output.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCIPlan } from "./ci-plan.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWED_SLACK = 5;

export function checkCoverageDrift(root, selectedWorkspaces = null, log = console.log) {
  const selected = selectedWorkspaces === null ? null : new Set(selectedWorkspaces);
  const configs = execFileSync("git", ["ls-files", "-z", "*/vitest.config.ts"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  let failures = 0;
  let compared = 0;
  let expected = 0;
  const fail = (message) => {
    log(`  FAIL  ${message}`);
    failures += 1;
  };
  log(`check-coverage-drift: floors must sit within ${ALLOWED_SLACK} points of the measurement\n`);
  for (const config of configs) {
    const workspace = dirname(config);
    if (selected !== null && !selected.has(workspace)) continue;
    const source = readFileSync(join(root, config), "utf8");
    const block = source.match(/thresholds:\s*\{([^}]*)\}/);
    if (!block) continue;
    const declared = {};
    for (const [, key, value] of block[1].matchAll(
      /(statements|functions)\s*:\s*(\d+(?:\.\d+)?)/g,
    )) {
      declared[key] = Number(value);
    }
    if (!Object.keys(declared).length) {
      fail(`${workspace}: no readable coverage floors in thresholds`);
      continue;
    }
    expected += 1;
    const summaryPath = join(root, workspace, "coverage/coverage-summary.json");
    if (!existsSync(summaryPath)) {
      fail(`${workspace}: missing coverage/coverage-summary.json for selected tests`);
      continue;
    }
    let summary;
    try {
      summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    } catch {
      fail(`${workspace}: coverage summary is not valid JSON`);
      continue;
    }
    for (const metric of ["statements", "functions"]) {
      if (declared[metric] === undefined) continue;
      const measured = summary?.total?.[metric]?.pct;
      if (
        typeof measured !== "number" ||
        !Number.isFinite(measured) ||
        measured < 0 ||
        measured > 100
      ) {
        fail(`${workspace}: coverage summary has no valid ${metric} percentage`);
        continue;
      }
      compared += 1;
      const slack = measured - declared[metric];
      if (slack > ALLOWED_SLACK) {
        fail(
          `${workspace}: ${metric} floor is ${declared[metric]} but measures ${measured.toFixed(2)} ` +
            `(${slack.toFixed(2)} points of slack) — ratchet it to ~${Math.floor(measured) - 3} ` +
            `in ${workspace}/vitest.config.ts`,
        );
      } else if (slack < 0) {
        fail(
          `${workspace}: ${metric} measures ${measured.toFixed(2)}, below its own floor of ${declared[metric]}`,
        );
      } else log(`  ok    ${workspace}: ${metric} ${declared[metric]} vs ${measured.toFixed(2)}`);
    }
  }
  if (selected === null && expected === 0)
    fail("no workspace coverage was compared — the check cannot pass vacuously");
  if (selected !== null && expected === 0 && failures === 0)
    log("  ok    no selected workspace declares Vitest coverage floors");
  log(
    `\ncheck-coverage-drift: ${failures ? `${failures} failure(s)` : `${compared} floor(s) within ${ALLOWED_SLACK} points of the measurement`}`,
  );
  return { failures, compared, expected };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length && (argv.length !== 2 || argv[0] !== "--plan"))
    throw new Error("Expected --plan <file> or no arguments");
  const plan = argv.length ? readCIPlan(repoRoot, argv[1]) : null;
  const result = checkCoverageDrift(
    repoRoot,
    plan && !plan.full ? plan.packages.map(({ path }) => path) : null,
  );
  if (result.failures) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`check-coverage-drift: ${error.message}`);
    process.exitCode = 1;
  }
}
