import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleHook, handleInput } from "./codex-hooks.mjs";

const skillBodies = {
  "writing-docs": "---\nname: writing-docs\n---\n# Writing docs in this repo\nfixture body",
  "composing-context": "# Composing context for an agent\ncomplete fixture body",
  "problem-solving": "# Working a problem\ncomplete fixture body",
};

function fixture(t, records = []) {
  const cwd = mkdtempSync(join(tmpdir(), "unimatrix-codex-hook-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [skill, body] of Object.entries(skillBodies)) {
    const directory = join(cwd, ".claude", "skills", skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), body);
  }
  mkdirSync(join(cwd, ".agents"));
  symlinkSync("../.claude/skills", join(cwd, ".agents", "skills"));
  const transcript = join(cwd, "transcript.jsonl");
  writeFileSync(transcript, records.map((row) => JSON.stringify(row)).join("\n"));
  const telemetryFile = join(cwd, "telemetry.jsonl");
  return {
    cwd,
    transcript,
    telemetryFile,
    options: { stateDirectory: join(cwd, "state"), telemetryFile },
    payload: {
      cwd,
      transcript_path: transcript,
      session_id: "fixture-session",
      turn_id: "fixture-turn",
    },
  };
}

const meta = { type: "session_meta", payload: { id: "fixture-session" } };
const turn = { type: "turn_context", payload: { turn_id: "fixture-turn" } };
const completion = (item, turnId = "fixture-turn") => ({
  type: "event_msg",
  payload: { type: "item_completed", turn_id: turnId, item },
});
const command = (overrides = {}) =>
  completion({
    type: "CommandExecution",
    id: "fixture-command",
    command: ["bash", "-lc", "pnpm check"],
    status: "completed",
    exit_code: 0,
    ...overrides,
  });
const edit = (path, text = "text", kind = "Update", move) =>
  `*** Begin Patch\n*** ${kind} File: ${path}\n${move ? `*** Move to: ${move}\n` : ""}@@\n+${text}\n*** End Patch`;
const post = (f, patch, extra = {}) => ({
  ...f.payload,
  hook_event_name: "PostToolUse",
  tool_name: "apply_patch",
  tool_input: { command: patch },
  tool_response: {},
  ...extra,
});
const context = (result) => result?.hookSpecificOutput.additionalContext ?? "";
const stop = (f, extra = {}) => ({
  ...f.payload,
  hook_event_name: "Stop",
  last_assistant_message: "pnpm check passed. Tests passed.",
  stop_hook_active: false,
  ...extra,
});
const readRecord = (f) =>
  JSON.parse(readFileSync(f.telemetryFile, "utf8").trim().split("\n").at(-1));

test("markdown edits produce the documented envelope and are remembered once per session", (t) => {
  const f = fixture(t, [meta, turn]);
  const payload = post(f, edit("docs/guide.md"));
  assert.equal(handleHook(payload, f.options).hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(handleHook(payload, f.options), null);
});

test("documentation and code-comment reminders retain separate branches in either order", (t) => {
  for (const paths of [
    ["docs/guide.md", "src/code.ts"],
    ["src/code.ts", "docs/guide.md"],
  ]) {
    const f = fixture(t, [meta, turn]);
    for (const path of paths) {
      const payload = post(f, edit(path, "// rationale"));
      assert.ok(handleHook(payload, f.options), path);
      assert.equal(handleHook(payload, f.options), null, path);
    }
  }
});

test("patches collect agent instructions, skill files, and moves across multiple files", (t) => {
  const f = fixture(t);
  const patch =
    "*** Begin Patch\n*** Add File: src/code.ts\n+const value = 1;\n*** Update File: draft.txt\n*** Move to: .claude/agents/reviewer.md\n@@\n+guidance\n*** End Patch";
  const result = context(handleHook(post(f, patch), f.options));
  assert.match(result, /writing-docs/);
  assert.match(result, /composing-context/);
});

test("deletions and excluded machine or scratch paths do not remind", (t) => {
  for (const path of [
    ".notes/plan.md",
    "dist/README.md",
    "node_modules/x/README.md",
    "guide.gen.md",
    "guide.min.md",
    "pnpm-lock.yaml",
  ]) {
    const f = fixture(t);
    assert.equal(handleHook(post(f, edit(path, "// comment")), f.options), null, path);
  }
  const f = fixture(t);
  assert.equal(handleHook(post(f, edit("docs/old.md", "", "Delete")), f.options), null);
});

test("comment additions remind without treating URLs, CSS variables, or shebangs as comments", (t) => {
  for (const text of [
    "// rationale",
    "/* rationale */",
    "# rationale",
    "<!-- rationale -->",
    "-- SQL rationale",
  ]) {
    const f = fixture(t);
    assert.match(
      context(handleHook(post(f, edit("src/code.ts", text)), f.options)),
      /writing-docs/,
    );
  }
  for (const text of [
    'const url = "https://example.invalid";',
    "#!/usr/bin/env bash",
    "--color: red;",
  ]) {
    const f = fixture(t);
    assert.equal(handleHook(post(f, edit("src/code.ts", text)), f.options), null);
  }
});

test("failed, malformed, and unrelated tool events do not remind", (t) => {
  for (const extra of [
    { tool_response: { error: "refused" } },
    { tool_response: { isError: true } },
    { tool_response: { success: false } },
    { tool_response: { exit_code: 1 } },
    { tool_response: "apply_patch verification failed: fixture" },
    { tool_name: "exec_command" },
  ]) {
    const f = fixture(t);
    assert.equal(handleHook(post(f, edit("docs/guide.md"), extra), f.options), null);
  }
  const f = fixture(t);
  assert.equal(handleHook(post(f, "not a patch"), f.options), null);
});

test("judgement prompts remind, short or imperative prompts do not", (t) => {
  const f = fixture(t);
  const result = handleHook(
    {
      ...f.payload,
      hook_event_name: "UserPromptSubmit",
      prompt: "How should we approach this given the trade-offs involved here",
    },
    f.options,
  );
  assert.equal(result.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(context(result), /problem-solving/);
  assert.equal(
    handleHook(
      { ...f.payload, hook_event_name: "UserPromptSubmit", prompt: "How should we test?" },
      f.options,
    ),
    null,
  );
});

test("only a successful actual skill read with body evidence suppresses reminders", (t) => {
  const skillRead = command({
    command: ["cat", ".claude/skills/writing-docs/SKILL.md"],
    parsed_cmd: [{ type: "read", path: ".claude/skills/writing-docs/SKILL.md" }],
    aggregated_output: skillBodies["writing-docs"],
  });
  const f = fixture(t, [meta, turn, skillRead]);
  assert.equal(handleHook(post(f, edit("docs/guide.md")), f.options), null);
  for (const record of [
    command({
      aggregated_output: skillBodies["writing-docs"],
      command: ["echo", "writing-docs"],
    }),
    {
      type: "response_item",
      payload: { type: "message", content: [{ text: "writing-docs # Writing docs in this repo" }] },
    },
    command({ ...skillRead.payload.item, exit_code: 1 }),
  ]) {
    const other = fixture(t, [meta, turn, record]);
    assert.match(
      context(handleHook(post(other, edit("docs/guide.md")), other.options)),
      /writing-docs/,
    );
  }
});

test("compaction clears loaded skill evidence and reminder sentinels", (t) => {
  const f = fixture(t, [meta, turn]);
  assert.ok(handleHook(post(f, edit("docs/guide.md")), f.options));
  writeFileSync(
    f.transcript,
    [meta, turn, { type: "compacted", payload: {} }].map(JSON.stringify).join("\n"),
  );
  assert.ok(handleHook(post(f, edit("docs/guide.md")), f.options));
  const other = fixture(t, [
    meta,
    turn,
    command({
      command: "cat .claude/skills/writing-docs/SKILL.md",
      aggregated_output: skillBodies["writing-docs"],
    }),
    { type: "compacted", payload: {} },
  ]);
  assert.ok(handleHook(post(other, edit("docs/guide.md")), other.options));
});

test("multi-file cat recognizes native skill discovery symlinks without parsed metadata", (t) => {
  const f = fixture(t, [
    meta,
    turn,
    command({
      command:
        'cat .agents/skills/writing-docs/SKILL.md ".claude/skills/composing-context/SKILL.md" .claude/skills/problem-solving/SKILL.md',
      parsed_cmd: [{ type: "unknown" }],
      aggregated_output: Object.values(skillBodies).join("\n"),
    }),
  ]);
  assert.equal(handleHook(post(f, edit("AGENTS.md")), f.options), null);
  assert.equal(
    handleHook(
      {
        ...f.payload,
        hook_event_name: "UserPromptSubmit",
        prompt: "How should we approach this given the trade-offs involved here",
      },
      f.options,
    ),
    null,
  );
  handleHook(stop(f), f.options);
  assert.deepEqual(readRecord(f).skills_loaded, [
    "composing-context",
    "problem-solving",
    "writing-docs",
  ]);
});

test("partial reads and truncated cat output cannot prove that a skill loaded", (t) => {
  for (const [text, output] of [
    ["sed -n '1,6p' .claude/skills/writing-docs/SKILL.md", skillBodies["writing-docs"]],
    ["cat .claude/skills/writing-docs/SKILL.md", "# Writing docs in this repo"],
    ["cat .claude/skills/writing-docs/SKILL.md", skillBodies["writing-docs"].slice(0, -4)],
  ]) {
    const f = fixture(t, [
      meta,
      turn,
      command({
        command: text,
        parsed_cmd: [{ type: "read", path: ".claude/skills/writing-docs/SKILL.md" }],
        aggregated_output: output,
      }),
    ]);
    assert.ok(handleHook(post(f, edit("docs/guide.md")), f.options), text);
    handleHook(stop(f), f.options);
    assert.equal(readRecord(f).skills_loaded, null);
  }
});

test("missing, unfamiliar, and truncated transcripts fail toward reminding", (t) => {
  for (const records of [[], [{ type: "unfamiliar", payload: { skill: "writing-docs" } }]]) {
    const f = fixture(t, records);
    assert.ok(handleHook(post(f, edit("docs/guide.md")), f.options));
  }
  const f = fixture(t, [meta]);
  writeFileSync(f.transcript, `${JSON.stringify(meta)}\n{"partial":`);
  assert.ok(handleHook(post(f, edit("docs/guide.md")), f.options));
  assert.ok(
    handleHook(
      post(f, edit("AGENTS.md"), {
        transcript_path: "/nonexistent-fixture.jsonl",
        session_id: "another-fixture",
      }),
      f.options,
    ),
  );
});

test("completed successful commands back claims only in their own turn", (t) => {
  const f = fixture(t, [
    meta,
    turn,
    command(),
    completion(
      {
        type: "CommandExecution",
        id: "old-check",
        command: "pnpm test",
        status: "completed",
        exit_code: 0,
      },
      "other-turn",
    ),
  ]);
  handleHook(stop(f), f.options);
  const record = readRecord(f);
  assert.equal(record.runtime, "codex");
  assert.equal(record.main_commands, 1);
  assert.deepEqual(record.backed_in_main, ["gate"]);
  assert.deepEqual(record.unbacked_families, ["test"]);
  assert.equal(JSON.stringify(record).includes("pnpm check"), false);
});

test("failed and incomplete commands never back passed-check claims", (t) => {
  const f = fixture(t, [
    meta,
    turn,
    command({ id: "failed", exit_code: 1 }),
    command({ id: "running", command: "pnpm test", status: "inProgress", exit_code: null }),
  ]);
  handleHook(stop(f), f.options);
  const record = readRecord(f);
  assert.deepEqual(record.backed_in_main, []);
  assert.equal(record.successful_commands, 0);
});

test("direct exec_command output is observed and duplicate app records count once", (t) => {
  const call = {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "direct-check",
      arguments: JSON.stringify({ cmd: "pnpm check" }),
    },
  };
  const output = {
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "direct-check",
      output: JSON.stringify({ exit_code: 0, output: "fixture passed" }),
    },
  };
  const f = fixture(t, [meta, turn, call, output]);
  handleHook(stop(f), f.options);
  assert.deepEqual(readRecord(f).backed_in_main, ["gate"]);
  const other = fixture(t, [meta, turn, call, command({ id: "direct-check" }), output]);
  handleHook(stop(other), other.options);
  assert.equal(readRecord(other).main_commands, 1);
});

test("observed subagent activity does not pretend its commands or dispatch semantics are known", (t) => {
  const f = fixture(t, [
    meta,
    turn,
    completion({ type: "SubAgentActivity", agent_thread_id: "fixture-agent", kind: "interacted" }),
    completion({ type: "SubAgentActivity", agent_thread_id: "fixture-agent", kind: "interacted" }),
  ]);
  handleHook(stop(f), f.options);
  const record = readRecord(f);
  assert.equal(record.subagent_threads_observed, 1);
  assert.equal(record.subagent_dispatches, null);
  assert.equal(record.subagent_commands, null);
  assert.equal(record.unbacked_families, null);
  assert.ok(record.degraded.includes("subagent-commands-unavailable"));
});

test("unknown turn and malformed or missing transcript cannot produce measured zero", (t) => {
  for (const records of [
    [],
    [{ type: "future-record", payload: {} }],
    [meta, command({ exit_code: undefined })],
  ]) {
    const f = fixture(t, records);
    handleHook(stop(f), f.options);
    const record = readRecord(f);
    assert.equal(record.measured, false);
    assert.equal(record.main_commands, null);
  }
  const f = fixture(t, [meta, turn, command()]);
  handleHook(stop(f, { turn_id: "not-observed" }), f.options);
  assert.equal(readRecord(f).main_commands, null);
  handleHook(stop(f, { transcript_path: undefined }), f.options);
  assert.ok(readRecord(f).degraded.includes("transcript-missing"));
});

test("session telemetry exposes unsupported metrics explicitly and contains no bodies", (t) => {
  const f = fixture(t, [meta, turn, command()]);
  handleHook(
    {
      ...f.payload,
      hook_event_name: "SessionEnd",
      reason: "other",
      prompt: "private fixture prompt",
    },
    f.options,
  );
  const record = readRecord(f);
  assert.equal(record.event, "session");
  assert.equal(record.main_commands, 1);
  assert.equal(record.touched_browser_surface, null);
  assert.equal(record.skill_tool_calls, null);
  assert.ok(record.degraded.includes("file-edits-and-agent-roles-unavailable"));
  assert.equal(JSON.stringify(record).includes("private fixture"), false);
});

test("default telemetry stays in existing scratch space and write failures are nonblocking", (t) => {
  const previousTelemetryFile = process.env.UNIMATRIX_CODEX_TELEMETRY_FILE;
  t.after(() => {
    if (previousTelemetryFile === undefined) delete process.env.UNIMATRIX_CODEX_TELEMETRY_FILE;
    else process.env.UNIMATRIX_CODEX_TELEMETRY_FILE = previousTelemetryFile;
  });
  delete process.env.UNIMATRIX_CODEX_TELEMETRY_FILE;
  const f = fixture(t, [meta, turn]);
  const warnings = [];
  const options = { warn: (warning) => warnings.push(warning) };
  assert.equal(handleHook(stop(f), options), null);
  assert.equal(warnings.length, 1);
  mkdirSync(join(f.cwd, ".notes"));
  handleHook(stop(f), options);
  assert.equal(
    JSON.parse(readFileSync(join(f.cwd, ".notes", "codex-session-log.jsonl"))).runtime,
    "codex",
  );
  assert.equal(
    handleHook(stop(f), { telemetryFile: join(f.cwd, "missing", "log.jsonl"), warn: options.warn }),
    null,
  );
  assert.match(warnings.at(-1), /output unavailable/);
});

test("oversized and malformed input are nonblocking with an advisory", () => {
  for (const input of ["{broken", "x".repeat(8 * 1024 * 1024 + 1)]) {
    const warnings = [];
    assert.equal(handleInput(input, { warn: (message) => warnings.push(message) }), null);
    assert.match(warnings[0], /codex-hooks:/);
  }
});

test("successful mentions, negation, and swallowed failures do not back check claims", (t) => {
  for (const text of [
    'echo "pnpm check"',
    'printf "pnpm check passed"',
    "cat vitest-results.txt",
    "! pnpm check",
    "pnpm check || true",
    "pnpm check; true",
    "false && pnpm check",
    "pnpm check --help",
    "vitest --help",
    "pnpm exec vitest list",
    "vitest bench",
    "vitest report",
    "vitest cache",
    "tsc --init",
    "tsc --listFilesOnly",
    "tsc --build --clean",
    "prettier --file-info fixture.ts",
    "prettier fixture.ts",
    "eslint --print-config fixture.ts",
    "node fixture.mjs --test",
  ]) {
    const f = fixture(t, [meta, turn, command({ command: text })]);
    handleHook(
      stop(f, {
        last_assistant_message:
          "pnpm check passed. Tests passed. Typecheck passed. Lint passed. Build passed.",
      }),
      f.options,
    );
    assert.deepEqual(readRecord(f).backed_in_main, [], text);
  }
});

test("simple pinned, workspace, and direct test commands provide real evidence", (t) => {
  for (const [text, family] of [
    ["./infra/scripts/pnpm-with-pinned-node.sh check", "gate"],
    ["pnpm --filter @unimatrix/api test", "test"],
    ["node --import tsx --test fixture.test.ts", "test"],
    ["pnpm exec vitest run fixture.test.ts", "test"],
  ]) {
    const f = fixture(t, [meta, turn, command({ command: text })]);
    handleHook(stop(f), f.options);
    assert.ok(readRecord(f).backed_in_main.includes(family), text);
  }
});

test("metadata alone cannot prove a measured zero", (t) => {
  const f = fixture(t, [meta, turn]);
  handleHook(stop(f), f.options);
  assert.equal(readRecord(f).main_commands, null);
  assert.ok(readRecord(f).degraded.includes("observation-coverage-unavailable"));
  assert.equal(readRecord(f).skills_loaded, null);
  assert.equal(readRecord(f).guidance_skill_invoked, null);
});

test("oversized transcripts report unknown measurements", (t) => {
  const f = fixture(t);
  writeFileSync(f.transcript, " ".repeat(8 * 1024 * 1024 + 1));
  handleHook(stop(f), f.options);
  assert.equal(readRecord(f).main_commands, null);
  assert.ok(readRecord(f).degraded.includes("transcript-input-too-large"));
});
