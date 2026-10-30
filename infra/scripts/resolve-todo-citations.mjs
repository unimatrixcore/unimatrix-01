#!/usr/bin/env node
//
// A `path/to/file:line` citation in a `.notes/01-todo/*.todo.md` item goes
// stale the moment a commit shifts, edits, or removes the cited line — nothing
// else in this repo notices, because `.notes/` is gitignored and no CI job
// reads it. Run this when reviewing a TODO: it re-derives each citation’s
// current line from a recorded
// baseline, rewrites what merely moved, and annotates what did not survive.
//
// The baseline is `.notes/.todo-citations.json`, keyed by the citation's exact
// current text so a hand-edited citation is treated as new rather than
// replaying a stale delta over it. Per citation it records the commit the
// baseline was taken at and the cited line's own text, because a rev+hunk
// replay only proposes a candidate line — the recorded text is what confirms
// or rejects it. That is what makes a baseline taken against a dirty working
// tree safe: if the file had uncommitted changes when the record was written,
// the rev doesn't reflect them but the text does, and a content-match fallback
// recovers the line when the arithmetic alone would double-count.
//
// Exit 0 whenever the tool ran, including when citations were annotated as
// stale — that outcome is reported *in the file*, which is the point of
// annotating in place rather than only printing a report. Non-zero is
// reserved for the tool failing to run at all (bad argument, not a git repo,
// malformed sidecar).
//
// A citation written inline in prose, rather than as a References entry, is
// invisible to all of the above — this only ever resolves entries inside a
// References block. Inline ones are reported (`INLINE`) instead of fixed:
// there is nowhere for a rewritten line number or a ` — STALE:` annotation to
// go mid-sentence, and `.notes/AGENTS.md` already bans them.
//
// Known limitation: `git diff`'s `diff --git a/... b/...` header quotes a
// path containing non-ASCII bytes under the default `core.quotepath`, which
// would break the rename/delete detection below. Every git invocation here
// passes `-c core.quotepath=false` to turn that off.
//
// repoRoot is NOT derived from this script's own location: the script must
// operate on whatever repo contains the target file (a throwaway fixture repo
// under fixtures, this monorepo in normal use), so it is discovered from the
// target path instead.

import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve as resolvePath } from "node:path";

const USAGE = `Usage:
  node infra/scripts/resolve-todo-citations.mjs <path-to-todo-file>
  node infra/scripts/resolve-todo-citations.mjs --help

Rewrites <path-to-todo-file> in place: a citation whose cited line merely
moved gets its line number updated; a citation whose file was renamed or
deleted, or whose line cannot be found, is annotated \` — STALE: <reason>\`.
A \`path:line\` written inline in prose instead of as a References entry is
reported (\`INLINE\`) but never rewritten. Baseline state lives in
<repo-root>/.notes/.todo-citations.json.

Exits non-zero only when the tool itself failed to run (bad argument, target
not inside a git repo, malformed sidecar) — never because a citation went
stale, which is reported in the file and on stdout instead.`;

class ToolError extends Error {}

function printHelp() {
  console.log(USAGE);
}

// --- git plumbing -----------------------------------------------------------

// Pinned alongside core.quotepath=false for the same reason: DIFF_GIT_RE below
// only matches the default `diff --git a/<path> b/<path>` header. A
// contributor with `diff.noprefix=true` or `diff.mnemonicPrefix=true` in
// their global git config gets a header with no `a/`/`b/` prefixes at all
// (`diff --git f.txt f.txt`), which silently fails to match, builds an empty
// diff map, and loses rename/delete detection with no error. Config, not
// `--default-prefix`, because the wrapper already applies config to every
// invocation and `--default-prefix` is a newer flag this repo hasn't
// confirmed is available in every git it targets.
const DIFF_PREFIX_ARGS = [
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
];

function git(repoRoot, args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...DIFF_PREFIX_ARGS, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function discoverRepoRoot(targetAbsPath) {
  try {
    return git(dirname(targetAbsPath), ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new ToolError(`${targetAbsPath} is not inside a git repository`);
  }
}

function headRev(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/**
 * One pathspec-free `git diff -U0 -M <rev>` per distinct baseline rev, parsed
 * once into old-path -> { status, newPath, hunks }.
 *
 * A pathspec defeats rename detection (`git diff --name-status -M <rev> --
 * f.txt` reports a plain delete, not a rename), and omitting the second rev
 * diffs `<rev>` against the working tree, which is what a citation tracks.
 */
function diffMapForRev(repoRoot, rev, cache) {
  if (cache.has(rev)) return cache.get(rev);
  let text;
  try {
    text = git(repoRoot, ["diff", "-U0", "-M", rev]);
  } catch (error) {
    throw new ToolError(`git diff against baseline ${rev} failed: ${error.message}`);
  }
  const map = parseGitDiff(text);
  cache.set(rev, map);
  return map;
}

const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parseGitDiff(text) {
  const files = new Map();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const header = DIFF_GIT_RE.exec(lines[i]);
    if (!header) {
      i += 1;
      continue;
    }
    let oldPath = header[1];
    let newPath = header[2];
    let status = "modified";
    i += 1;
    while (i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("@@")) {
      if (lines[i].startsWith("deleted file mode")) status = "deleted";
      if (lines[i].startsWith("rename from ")) {
        oldPath = lines[i].slice("rename from ".length);
        status = "renamed";
      }
      if (lines[i].startsWith("rename to ")) {
        newPath = lines[i].slice("rename to ".length);
        status = "renamed";
      }
      i += 1;
    }
    const hunks = [];
    while (i < lines.length && lines[i].startsWith("@@")) {
      const hunk = HUNK_RE.exec(lines[i]);
      if (hunk) {
        hunks.push({
          a: Number(hunk[1]),
          b: hunk[2] === undefined ? 1 : Number(hunk[2]),
          d: hunk[4] === undefined ? 1 : Number(hunk[4]),
        });
      }
      i += 1;
      while (
        i < lines.length &&
        !lines[i].startsWith("@@") &&
        !lines[i].startsWith("diff --git ")
      ) {
        i += 1;
      }
    }
    files.set(oldPath, { status, newPath, hunks });
  }
  return files;
}

// --- sidecar -----------------------------------------------------------------

function sidecarPath(repoRoot) {
  return join(repoRoot, ".notes", ".todo-citations.json");
}

function loadSidecar(repoRoot) {
  const path = sidecarPath(repoRoot);
  if (!existsSync(path)) return { version: 1, files: {} };
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ToolError(`cannot read sidecar ${path}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ToolError(`malformed sidecar ${path}: ${error.message}`);
  }
  if (
    typeof data !== "object" ||
    data === null ||
    typeof data.files !== "object" ||
    data.files === null
  ) {
    throw new ToolError(`malformed sidecar ${path}: expected a "files" object`);
  }
  return data;
}

function saveSidecar(repoRoot, data) {
  const path = sidecarPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// --- todo-file parsing --------------------------------------------------------

const REFERENCES_OPEN_RE = /^\s*-\s*(\(opt\)\s*)?\*\*References:\*\*/;
const SECTION_RE = /^\s*-\s+\*\*/;
const ENTRY_RE = /^(\s*)([a-z]+)\.\s+`([^`]*)`(.*)$/;
const CITATION_RE = /^(.+):(\d+)(?:-(\d+))?$/;
// A PR entry (`PR #208`) has no colon at all, so it never reaches this guard.
// A link entry does, in its scheme (`https:`) — this is what stops
// `https://example.com:8080` from reading as path `https://example.com`, line
// `8080`, since a colon-then-port is otherwise indistinguishable from
// colon-then-line-number.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const BACKTICKED_TOKEN_RE = /`([^`]+)`/g;
// Strips a marker this tool itself appended (` — STALE: <reason>`) so a
// rewrite regenerates it instead of accumulating a second one; anything
// else in the trailing text is the owner's prose and survives verbatim.
const STALE_MARKER_RE = / — STALE:.*$/;

/** Parses a bare token (no backticks) into a path:line/range citation, or null if it isn't one. */
function parseCitationToken(token) {
  if (URL_SCHEME_RE.test(token)) return null;
  const match = CITATION_RE.exec(token);
  if (!match) return null;
  return {
    path: match[1],
    startLine: Number(match[2]),
    endLine: match[3] !== undefined ? Number(match[3]) : null,
  };
}

/** Entries inside a References block whose first backticked token is a path:line/range citation. */
function parseCitationEntries(bodyLines) {
  const entries = [];
  let inBlock = false;
  for (let i = 0; i < bodyLines.length; i += 1) {
    const line = bodyLines[i];
    if (REFERENCES_OPEN_RE.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && SECTION_RE.test(line)) {
      inBlock = false;
      continue;
    }
    if (!inBlock) continue;
    const entryMatch = ENTRY_RE.exec(line);
    if (!entryMatch) continue;
    const [, indent, letter, token, suffix] = entryMatch;
    const citation = parseCitationToken(token);
    if (!citation) continue;
    entries.push({
      lineIndex: i,
      indent,
      letter,
      path: citation.path,
      startLine: citation.startLine,
      endLine: citation.endLine,
      citationKey: token,
      trailingText: suffix.replace(STALE_MARKER_RE, ""),
    });
  }
  return entries;
}

/**
 * Backticked path:line/range tokens found outside any References block.
 * `resolve-todo-citations.mjs` only resolves entries inside one, so an inline
 * citation in prose goes stale silently — this reports it rather than fixing
 * it, since a References entry is where it belongs instead.
 */
function findInlineCitations(bodyLines) {
  const found = [];
  let inBlock = false;
  for (let i = 0; i < bodyLines.length; i += 1) {
    const line = bodyLines[i];
    if (REFERENCES_OPEN_RE.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && SECTION_RE.test(line)) {
      inBlock = false;
      continue;
    }
    if (inBlock) continue;
    for (const match of line.matchAll(BACKTICKED_TOKEN_RE)) {
      const citation = parseCitationToken(match[1]);
      if (citation) found.push({ lineIndex: i, ...citation });
    }
  }
  return found;
}

function rangeText(start, end) {
  return end != null ? `${start}-${end}` : `${start}`;
}

function reconstructLine(entry, path, start, end, staleReason) {
  const stale = staleReason ? ` — STALE: ${staleReason}` : "";
  return `${entry.indent}${entry.letter}. \`${path}:${rangeText(start, end)}\`${entry.trailingText}${stale}`;
}

// --- line resolution -----------------------------------------------------------

/**
 * Per-endpoint candidate from the hunks in order.
 *
 * `Math.max(h.b, 1)` is load-bearing: a pure insertion emits `@@ -a,0 +c,d @@`
 * with the old count explicitly 0, and `a` names the line the insertion
 * follows, not the line it replaces. Treating `oldLast` as `a - 1` in that
 * case (the naive `a + b - 1` with `b == 0`) reads an insertion after line `a`
 * as a change above line `a` itself, and shifts a citation on `a` that the
 * insertion never touched.
 */
function endpointCandidate(line, hunks) {
  let delta = 0;
  for (const hunk of hunks) {
    const oldLast = hunk.a + Math.max(hunk.b, 1) - 1;
    if (oldLast < line) {
      delta += hunk.d - hunk.b;
      continue;
    }
    if (hunk.b > 0 && hunk.a <= line && line <= hunk.a + hunk.b - 1) {
      return { touched: true, candidate: null };
    }
    break;
  }
  return { touched: false, candidate: line + delta };
}

/**
 * Resolves one endpoint against its recorded text. The rev+hunk pass only
 * proposes `candidate`; the recorded text confirms or rejects it, and an
 * unconfirmed candidate is never returned. A confirmed candidate is unshifted
 * arithmetic done for nothing (`touched`) is also confirmable this way, since
 * `candidate` is null and the direct check is skipped, falling straight to
 * the whole-file content search.
 */
function resolveEndpoint(line, hunks, recordedText, currentLines) {
  const { candidate } = endpointCandidate(line, hunks);
  if (candidate !== null && currentLines[candidate - 1] === recordedText) {
    return { ok: true, line: candidate, viaContent: false };
  }
  const matches = [];
  for (let i = 0; i < currentLines.length; i += 1) {
    if (currentLines[i] === recordedText) matches.push(i + 1);
  }
  if (matches.length === 1) {
    return { ok: true, line: matches[0], viaContent: true, diffCandidate: candidate };
  }
  return { ok: false };
}

// --- per-citation resolution -----------------------------------------------------

function readLines(repoRoot, path, cache) {
  if (cache.has(path)) return cache.get(path);
  const abs = join(repoRoot, path);
  let result;
  if (!existsSync(abs)) {
    result = null;
  } else {
    const content = readFileSync(abs, "utf8");
    const body = content.endsWith("\n") ? content.slice(0, -1) : content;
    result = body.split("\n");
  }
  cache.set(path, result);
  return result;
}

function lineAt(lines, n) {
  if (n < 1 || n > lines.length) return undefined;
  return lines[n - 1];
}

/**
 * Resolves one citation entry against the sidecar's records for this todo
 * file, mutating `fileRecords` in place per the rules below.
 *
 * A record with no match is a first encounter: verify path and line exist,
 * baseline them, and never rewrite anything. A record that matches is
 * replayed against a pathspec-free diff from its baseline rev — a rename or a
 * deletion is always annotated rather than resolved (the path is never
 * auto-rewritten); otherwise both endpoints are resolved independently and
 * applied all-or-nothing. Any failure leaves the record's `rev`/`text` alone
 * so the original baseline survives for a later attempt.
 */
function resolveEntry(repoRoot, entry, fileRecords, diffCache, linesCache, currentHead) {
  const existing = fileRecords[entry.citationKey];

  if (!existing) {
    const lines = readLines(repoRoot, entry.path, linesCache);
    if (lines === null) {
      return { outcome: "stale", reason: "file not found" };
    }
    const startText = lineAt(lines, entry.startLine);
    if (startText === undefined) {
      return {
        outcome: "stale",
        reason: entry.endLine != null ? "start line not found" : "line not found",
      };
    }
    const text = [startText];
    if (entry.endLine != null) {
      const endText = lineAt(lines, entry.endLine);
      if (endText === undefined) {
        return { outcome: "stale", reason: "end line not found" };
      }
      text.push(endText);
    }
    fileRecords[entry.citationKey] = { rev: currentHead, text };
    return { outcome: "baselined", finalKey: entry.citationKey };
  }

  const diffMap = diffMapForRev(repoRoot, existing.rev, diffCache);
  const fileEntry = diffMap.get(entry.path);

  if (fileEntry?.status === "renamed") {
    return { outcome: "stale", reason: `file moved to \`${fileEntry.newPath}\`` };
  }
  if (fileEntry?.status === "deleted") {
    return { outcome: "stale", reason: "file deleted" };
  }
  if (!fileEntry && !existsSync(join(repoRoot, entry.path))) {
    return { outcome: "stale", reason: "file not found" };
  }

  const hunks = fileEntry ? fileEntry.hunks : [];
  const currentLines = readLines(repoRoot, entry.path, linesCache);

  const start = resolveEndpoint(entry.startLine, hunks, existing.text[0], currentLines);
  const end =
    entry.endLine != null
      ? resolveEndpoint(entry.endLine, hunks, existing.text[1], currentLines)
      : null;

  if (!start.ok || (end && !end.ok)) {
    let reason;
    if (entry.endLine == null) {
      reason = "line changed or removed";
    } else if (!start.ok && !end.ok) {
      reason = `start line ${entry.startLine} and end line ${entry.endLine} changed or removed`;
    } else if (!start.ok) {
      reason = `start line ${entry.startLine} changed or removed`;
    } else {
      reason = `end line ${entry.endLine} changed or removed`;
    }
    return { outcome: "stale", reason };
  }

  const newStart = start.line;
  const newEnd = end ? end.line : null;
  const changed = newStart !== entry.startLine || (newEnd != null && newEnd !== entry.endLine);
  const viaContent = start.viaContent || (end?.viaContent ?? false);
  const newKey = `${entry.path}:${rangeText(newStart, newEnd)}`;

  if (changed) {
    delete fileRecords[entry.citationKey];
    fileRecords[newKey] = { rev: currentHead, text: existing.text };
  }

  return {
    outcome: changed ? (viaContent ? "recovered" : "moved") : "unchanged",
    finalKey: newKey,
    oldStart: entry.startLine,
    oldEnd: entry.endLine,
    newStart,
    newEnd,
    diffCandidate: viaContent ? (start.viaContent ? start.diffCandidate : end.diffCandidate) : null,
  };
}

// --- report formatting -----------------------------------------------------------

function reportRow(label, content) {
  return `  ${label.padEnd(11)} ${content}`;
}

function formatCandidate(candidate) {
  return candidate === null || candidate === undefined ? "line touched" : `:${candidate}`;
}

function formatInlineRow(citation) {
  return reportRow(
    "INLINE",
    `${citation.path}:${rangeText(citation.startLine, citation.endLine)}  (line ${citation.lineIndex + 1}) — move to a References entry`,
  );
}

// --- top-level file processing -----------------------------------------------

function processFile(repoRoot, targetAbsPath) {
  // targetAbsPath is already canonical (main.js resolves it once, up
  // front), so todoRel is the same sidecar key regardless of whether the
  // caller reached this file through a worktree symlink. The report header
  // below prints this canonical path rather than whatever the caller
  // typed: it is the path the sidecar actually keys on, so it is what a
  // reader needs to find the matching entry in
  // `.notes/.todo-citations.json`.
  const todoRel = relative(repoRoot, targetAbsPath).split("\\").join("/");
  const original = readFileSync(targetAbsPath, "utf8");
  const hasTrailingNewline = original.endsWith("\n");
  const bodyLines = (hasTrailingNewline ? original.slice(0, -1) : original).split("\n");
  const entries = parseCitationEntries(bodyLines);
  const inlineCitations = findInlineCitations(bodyLines);

  console.log(`resolve-todo-citations: ${todoRel}\n`);

  // An inline citation is reported whether or not the file has any References
  // entries at all. It is never rewritten, never annotated, and never
  // touches the sidecar — the sidecar section below is skipped entirely when
  // there are no References-block entries to baseline.
  if (entries.length === 0) {
    if (inlineCitations.length > 0) {
      for (const citation of inlineCitations) console.log(formatInlineRow(citation));
      console.log("");
      console.log(`  ${inlineCitations.length} inline`);
    } else {
      console.log("  0 citations with line numbers");
    }
    return;
  }

  const sidecar = loadSidecar(repoRoot);
  const fileRecords = sidecar.files[todoRel] ?? {};
  sidecar.files[todoRel] = fileRecords;

  const currentHead = headRev(repoRoot);
  const diffCache = new Map();
  const linesCache = new Map();
  const seenKeys = new Set();
  const reportRows = [];
  const counts = {
    moved: 0,
    recovered: 0,
    baselined: 0,
    stale: 0,
    inline: inlineCitations.length,
  };
  for (const citation of inlineCitations) reportRows.push(formatInlineRow(citation));

  let changedFile = false;

  // Two References entries can cite the identical path:line, and the sidecar
  // keys a record by that literal text — so they must resolve exactly once,
  // together, off the one record that names them both. Resolving per entry
  // instead re-keys the record mid-loop on the first occurrence's move,
  // leaving the second occurrence looking up a key that is already gone; it
  // then reads as first-seen and baselines against whatever now sits at the
  // stale line, recording a wrong answer as correct with no later run able
  // to self-correct it. Grouping by citationKey and resolving one result per
  // group — applied identically to every entry in it — is what keeps
  // duplicate citations in lockstep. The report and the counts follow the
  // same grouping: one row and one count per unique citation, not one per
  // occurrence, so a citation cited twice is not double-counted.
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.citationKey);
    if (group) group.push(entry);
    else groups.set(entry.citationKey, [entry]);
  }

  for (const [citationKey, groupEntries] of groups) {
    const representative = groupEntries[0];
    const result = resolveEntry(
      repoRoot,
      representative,
      fileRecords,
      diffCache,
      linesCache,
      currentHead,
    );
    if (result.finalKey) seenKeys.add(result.finalKey);
    else seenKeys.add(citationKey);

    let lineFor;
    switch (result.outcome) {
      case "baselined":
        counts.baselined += 1;
        reportRows.push(
          reportRow(
            "baselined",
            `${representative.path}:${rangeText(representative.startLine, representative.endLine)}`,
          ),
        );
        lineFor = (entry) =>
          reconstructLine(entry, entry.path, entry.startLine, entry.endLine, null);
        break;
      case "stale":
        counts.stale += 1;
        reportRows.push(
          reportRow(
            "STALE",
            `${representative.path}:${rangeText(representative.startLine, representative.endLine)}  ${result.reason}`,
          ),
        );
        lineFor = (entry) =>
          reconstructLine(entry, entry.path, entry.startLine, entry.endLine, result.reason);
        break;
      case "moved":
        counts.moved += 1;
        reportRows.push(
          reportRow(
            "moved",
            `${representative.path}:${rangeText(result.oldStart, result.oldEnd)} -> :${rangeText(result.newStart, result.newEnd)}`,
          ),
        );
        lineFor = (entry) =>
          reconstructLine(entry, entry.path, result.newStart, result.newEnd, null);
        break;
      case "recovered":
        counts.recovered += 1;
        reportRows.push(
          reportRow(
            "recovered",
            `${representative.path}:${rangeText(result.oldStart, result.oldEnd)} -> :${rangeText(result.newStart, result.newEnd)}  (by content match; diff said ${formatCandidate(result.diffCandidate)})`,
          ),
        );
        lineFor = (entry) =>
          reconstructLine(entry, entry.path, result.newStart, result.newEnd, null);
        break;
      case "unchanged":
        lineFor = (entry) =>
          reconstructLine(entry, entry.path, entry.startLine, entry.endLine, null);
        break;
      default:
        throw new ToolError(`unreachable resolution outcome: ${result.outcome}`);
    }

    for (const entry of groupEntries) {
      const newLine = lineFor(entry);
      if (newLine !== bodyLines[entry.lineIndex]) {
        bodyLines[entry.lineIndex] = newLine;
        changedFile = true;
      }
    }
  }

  for (const key of Object.keys(fileRecords)) {
    if (!seenKeys.has(key)) delete fileRecords[key];
  }

  if (changedFile) {
    const rewritten = bodyLines.join("\n") + (hasTrailingNewline ? "\n" : "");
    writeFileSync(targetAbsPath, rewritten, "utf8");
  }

  saveSidecar(repoRoot, sidecar);

  if (reportRows.length > 0) {
    for (const row of reportRows) console.log(row);
    console.log("");
    const summary = [];
    if (counts.moved > 0) summary.push(`${counts.moved} rewritten`);
    if (counts.recovered > 0) summary.push(`${counts.recovered} recovered`);
    if (counts.baselined > 0) summary.push(`${counts.baselined} baselined`);
    if (counts.stale > 0) summary.push(`${counts.stale} needs attention`);
    if (counts.inline > 0) summary.push(`${counts.inline} inline`);
    console.log(`  ${summary.join(", ")}`);
  } else {
    console.log(`  ${entries.length} citation(s) with line numbers, all confirmed fresh`);
  }
}

// --- main ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (args.length !== 1) {
    throw new ToolError(`expected exactly one argument, got ${args.length} — ${USAGE}`);
  }

  const asTypedPath = resolvePath(process.cwd(), args[0]);
  if (!existsSync(asTypedPath)) {
    throw new ToolError(`no such file: ${asTypedPath}`);
  }

  // Canonicalize once, up front, before anything else derives from the
  // target path. `infra/scripts/link-worktree-dirs.mjs` symlinks `.notes/`
  // into every new worktree, so the as-typed path and the real path
  // disagree there. `discoverRepoRoot` already resolves symlinks (it
  // shells out to git, which does), so deriving `todoRel` from the
  // as-typed path instead of this same realpath is what produced two
  // independent sidecar keys for one physical file. realpathSync throws on
  // a missing path, but `existsSync` just above already guarantees the
  // target exists.
  const targetAbsPath = realpathSync(asTypedPath);

  const repoRoot = discoverRepoRoot(targetAbsPath);
  processFile(repoRoot, targetAbsPath);
}

try {
  main();
} catch (error) {
  if (error instanceof ToolError) {
    console.error(`resolve-todo-citations: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
