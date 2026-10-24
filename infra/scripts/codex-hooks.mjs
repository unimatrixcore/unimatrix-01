import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 8 * 1024 * 1024;
const SKILLS = {
  "writing-docs": "# Writing docs in this repo",
  "composing-context": "# Composing context for an agent",
  "problem-solving": "# Working a problem",
};
const REASONS = {
  "writing-docs":
    "Read .claude/skills/writing-docs/SKILL.md before composing more guidance or comments. It governs current, verified guidance and comments that explain what code cannot express.",
  "composing-context":
    "Read .claude/skills/composing-context/SKILL.md before continuing agent-facing guidance. It governs whether a rule belongs and which context layer should carry it.",
  "problem-solving":
    "Read .claude/skills/problem-solving/SKILL.md before answering. Separate concerns, name the binding constraint, research the repo and upstream, compare options, and state a recommendation with its limits.",
};

function boundedRead(pathOrDescriptor) {
  let descriptor;
  try {
    descriptor =
      typeof pathOrDescriptor === "number" ? pathOrDescriptor : openSync(pathOrDescriptor, "r");
    if (fstatSync(descriptor).size > LIMIT) return { error: "input-too-large" };
    const chunks = [];
    let total = 0;
    while (total <= LIMIT) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, LIMIT + 1 - total));
      const size = readSync(descriptor, chunk, 0, chunk.length, null);
      if (size === 0) return { text: Buffer.concat(chunks).toString("utf8") };
      total += size;
      chunks.push(chunk.subarray(0, size));
    }
    return { error: "input-too-large" };
  } catch {
    return { error: "input-unreadable" };
  } finally {
    if (descriptor !== undefined && typeof pathOrDescriptor !== "number") {
      closeSync(descriptor);
    }
  }
}

function parsedJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function commandText(command) {
  if (!Array.isArray(command)) return command;
  if (
    command.length === 3 &&
    /(?:^|\/)(?:bash|sh|zsh)$/.test(command[0]) &&
    /^-[a-z]*c[a-z]*$/.test(command[1])
  )
    return command[2];
  return command.every((part) => typeof part === "string") ? command.join(" ") : undefined;
}

function skillFromPath(path) {
  return typeof path === "string"
    ? path
        .replaceAll("\\", "/")
        .match(/(?:^|\/)\.(?:claude|agents)\/skills\/([^/]+)\/SKILL\.md$/)?.[1]
    : undefined;
}

function simpleWords(command) {
  if (typeof command !== "string" || /[;&|<>`$!\\\n\r]/.test(command)) return null;
  const words = [];
  let rest = command;
  while (rest.trim()) {
    const word = rest.match(/^\s*(?:"([^"]*)"|'([^']*)'|([^\s'"]+))(?=\s|$)/);
    if (!word) return null;
    words.push(word[1] ?? word[2] ?? word[3]);
    rest = rest.slice(word[0].length);
  }
  return words;
}

function readSkills(command, output, cwd, root) {
  if (typeof output !== "string" || typeof root !== "string") return [];
  const words = simpleWords(command);
  if (words?.shift()?.split("/").at(-1) !== "cat") return [];
  if (words[0] === "--") words.shift();
  if (words.some((word) => word.startsWith("-"))) return [];
  // Partial reads and truncated bodies cannot establish that the instructions loaded.
  return words.flatMap((path) => {
    const skill = skillFromPath(path);
    if (!SKILLS[skill]) return [];
    const canonical = join(root, ".claude", "skills", skill, "SKILL.md");
    try {
      if (realpathSync(resolve(cwd ?? root, path)) !== realpathSync(canonical)) return [];
      const body = boundedRead(canonical).text?.trimEnd();
      return body && body.split("\n").includes(SKILLS[skill]) && output.includes(body)
        ? [skill]
        : [];
    } catch {
      return [];
    }
  });
}

function transcriptState(path, root) {
  const state = {
    commands: [],
    activities: [],
    skills: new Set(),
    allSkills: new Set(),
    compactions: 0,
    turns: new Set(),
    recognized: false,
    reasons: [],
  };
  if (!path) return { ...state, reasons: ["transcript-missing"] };
  const read = boundedRead(path);
  if (read.error) return { ...state, reasons: [`transcript-${read.error}`] };
  const pending = new Map();
  const commandIds = new Set();
  let turn;
  for (const line of read.text.split("\n")) {
    if (!line.trim()) continue;
    const row = parsedJson(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      state.reasons.push("transcript-malformed");
      continue;
    }
    const data = row.payload;
    if (
      row.type === "compacted" ||
      (row.type === "event_msg" && data?.type === "context_compacted")
    ) {
      state.compactions++;
      state.skills.clear();
    }
    if (row.type === "session_meta" && typeof data?.id === "string") {
      state.recognized = true;
      state.metadata = data;
    }
    if (
      row.type === "turn_context" ||
      (row.type === "event_msg" && data?.type === "task_started")
    ) {
      turn = typeof data?.turn_id === "string" ? data.turn_id : undefined;
      if (turn) state.turns.add(turn);
    }
    const item = row.type === "event_msg" && data?.type === "item_completed" ? data.item : null;
    if (item && typeof data.turn_id === "string") state.turns.add(data.turn_id);
    if (item?.type === "CommandExecution") {
      const id = item.id;
      if (typeof id === "string" && commandIds.has(id)) continue;
      if (typeof id === "string") commandIds.add(id);
      const command = commandText(item.command);
      if (
        typeof command !== "string" ||
        typeof item.status !== "string" ||
        (item.exit_code !== null && !Number.isInteger(item.exit_code))
      ) {
        state.reasons.push("command-shape-unrecognized");
        continue;
      }
      const successful = item.status === "completed" && item.exit_code === 0;
      state.commands.push({ command, successful, turn: data.turn_id ?? turn });
      if (successful) {
        for (const skill of readSkills(command, item.aggregated_output, item.cwd ?? root, root)) {
          state.skills.add(skill);
          state.allSkills.add(skill);
        }
      }
    }
    if (item?.type === "SubAgentActivity") {
      if (typeof item.agent_thread_id !== "string")
        state.reasons.push("agent-identity-unavailable");
      state.activities.push({ id: item.agent_thread_id, turn: data.turn_id ?? turn });
    }
    if (row.type !== "response_item") continue;
    if (data?.type === "function_call") {
      const input = parsedJson(data.arguments);
      if (data.name === "exec_command" && typeof input?.cmd === "string") {
        pending.set(data.call_id, { command: input.cmd, cwd: input.workdir ?? root, turn });
      }
    }
    if (data?.type === "function_call_output" && pending.has(data.call_id)) {
      const call = pending.get(data.call_id);
      pending.delete(data.call_id);
      if (commandIds.has(data.call_id)) continue;
      commandIds.add(data.call_id);
      const result = parsedJson(data.output);
      if (
        !result ||
        typeof result !== "object" ||
        (!Number.isInteger(result.exit_code) && !result.session_id)
      )
        state.reasons.push("command-result-unrecognized");
      const successful = result?.exit_code === 0 && !result.session_id;
      state.commands.push({ ...call, successful });
      if (successful) {
        for (const skill of readSkills(call.command, result.output, call.cwd, root)) {
          state.skills.add(skill);
          state.allSkills.add(skill);
        }
      }
    }
  }
  if (!state.recognized) state.reasons.push("transcript-format-unrecognized");
  return state;
}

function excluded(path) {
  return (
    /(?:^|\/)\.notes\//.test(path) ||
    /(?:-lock\.(?:yaml|json)|\.lock|\.snap)$/.test(path) ||
    /(?:\.gen\.|\.min\.|\/(?:node_modules|dist)\/)/.test(`/${path}`)
  );
}

function patchEdits(patch) {
  if (
    typeof patch !== "string" ||
    !patch.startsWith("*** Begin Patch\n") ||
    !patch.trimEnd().endsWith("*** End Patch")
  )
    return [];
  const edits = [];
  let edit;
  for (const line of patch.split("\n")) {
    const file = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (file) {
      edit = { path: file[2], removed: file[1] === "Delete", added: [] };
      edits.push(edit);
    } else if (edit && line.startsWith("*** Move to: ")) {
      edit.path = line.slice(13);
    } else if (edit && line.startsWith("+") && !line.startsWith("+++")) {
      edit.added.push(line.slice(1));
    }
  }
  return edits.filter((entry) => !entry.removed && !excluded(entry.path));
}

function patchFailed(response) {
  if (response && typeof response === "object") {
    if (
      response.error ||
      response.isError ||
      response.success === false ||
      (typeof response.exit_code === "number" && response.exit_code !== 0)
    )
      return true;
    response = response.output;
  }
  return (
    typeof response === "string" &&
    /^\s*(?:Error|Failed|apply_patch verification failed)\b/i.test(response)
  );
}

function requestedReminders(payload) {
  if (payload.hook_event_name === "UserPromptSubmit") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    return prompt.trim().split(/\s+/).length >= 8 &&
      /how should|how do we|how would we|how can we|what is the best|what's the best|which approach|should we|should i|is it worth|what are the options|what options|what else|trade-?off|why does|why is|what would you|do you think|better approach|alternatives|recommend/i.test(
        prompt,
      )
      ? [{ skill: "problem-solving", branch: "prompt" }]
      : [];
  }
  if (
    payload.hook_event_name !== "PostToolUse" ||
    payload.tool_name !== "apply_patch" ||
    patchFailed(payload.tool_response)
  )
    return [];
  const edits = patchEdits(payload.tool_input?.command);
  const reminders = new Map();
  for (const edit of edits) {
    if (/\.mdx?$/.test(edit.path)) reminders.set("docs", { skill: "writing-docs", branch: "docs" });
    else if (
      edit.added.some((line) => /^\s*(?:\/\/|\/\*|\*[ /]|\{\/\*|<!--|#(?:$|[^!])|-- )/.test(line))
    )
      reminders.set("comments", { skill: "writing-docs", branch: "comments" });
    if (
      /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(edit.path) ||
      /(?:^|\/)\.(?:claude|agents)\/(?:skills|agents)\/.*\.md$/.test(edit.path)
    )
      reminders.set("context", { skill: "composing-context", branch: "context" });
  }
  return [...reminders.values()];
}

function reminderOutput(payload, state, options) {
  const messages = [];
  for (const { skill, branch } of requestedReminders(payload)) {
    if (state.reasons.length === 0 && state.skills.has(skill)) continue;
    if (typeof payload.session_id === "string" && payload.session_id) {
      const key = createHash("sha256")
        .update(JSON.stringify([payload.cwd, payload.session_id, state.compactions, skill, branch]))
        .digest("hex");
      try {
        const directory = options.stateDirectory ?? join(tmpdir(), "unimatrix-codex-reminders");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(join(directory, key), "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code === "EEXIST") continue;
      }
    }
    messages.push(
      branch === "comments"
        ? "Read .claude/skills/writing-docs/SKILL.md before composing more code comments. Match surrounding comment density and explain what code cannot express; removing a mechanism includes checking its comments."
        : REASONS[skill],
    );
  }
  return messages.length
    ? {
        hookSpecificOutput: {
          hookEventName: payload.hook_event_name,
          additionalContext: messages.join("\n"),
        },
      }
    : null;
}

function checkFamilies(command) {
  const words = simpleWords(command);
  if (
    !words ||
    words.some((word) =>
      [
        "--help",
        "-h",
        "--version",
        "-v",
        "--dry-run",
        "--list",
        "--showConfig",
        "--listTests",
        "--collectOnly",
        "--listFilesOnly",
        "--init",
        "--clean",
        "--watch",
        "--find-config-path",
        "--file-info",
        "--print-config",
        "--inspect-config",
        "--env-info",
        "--list-optional",
      ].includes(word),
    )
  )
    return null;
  let executable = words.shift()?.split("/").at(-1);
  if (executable === "pnpm-with-pinned-node.sh") executable = "pnpm";
  if (executable === "pnpm") {
    while (words[0]?.startsWith("-")) {
      const option = words.shift();
      if (["--filter", "-F", "-C", "--dir", "--prefix", "--reporter"].includes(option)) {
        if (!words.shift()) return null;
      } else if (!["--workspace-root", "-w", "--silent", "-s"].includes(option)) return null;
    }
    if (words[0] === "exec") return checkFamilies(words.slice(1).join(" "));
    if (words[0] === "run") words.shift();
    const task = words[0];
    if (["check", "verify"].includes(task)) return ["gate"];
    if (["test", "test:unit", "test:smoke"].includes(task)) return ["test"];
    if (["lint", "format:check"].includes(task)) return ["lint"];
    if (task === "typecheck") return ["typecheck"];
    if (task === "build") return ["build"];
    return null;
  }
  if (["eslint", "shellcheck"].includes(executable)) return ["lint"];
  if (executable === "prettier")
    return words.some((word) => ["--check", "-c", "--list-different", "-l"].includes(word))
      ? ["lint"]
      : null;
  if (executable === "vitest") return ["run", "--run"].includes(words[0]) ? ["test"] : null;
  if (executable === "playwright" && words[0] === "test") return ["test"];
  if (executable === "node") {
    while (words.length) {
      const option = words.shift();
      if (option === "--test") return ["test"];
      if (["--import", "--require", "-r", "--loader"].includes(option)) words.shift();
      else return null;
    }
    return null;
  }
  if (executable === "tsc")
    return words.includes("-b") || words.includes("--build")
      ? ["build", "typecheck"]
      : ["typecheck"];
  if (["vite", "docker"].includes(executable) && words[0] === "build") return ["build"];
  if (executable === "turbo" && words[0] === "run")
    return words.slice(1).filter((task) => ["build", "lint", "test", "typecheck"].includes(task));
  return ["cat", "ls", "rg", "printf", "echo", "sed", "git", "pwd", "head", "tail", "wc"].includes(
    executable,
  )
    ? []
    : null;
}

function claims(message) {
  if (typeof message !== "string") return null;
  const text = message.replace(/```[^]*?(?:```|$)/g, "");
  const units = text
    .split(/(?<=[.!?])\s+/)
    .filter(
      (unit) =>
        !/\b(?:if|would|were|was|had been|stays?|stayed|left|despite|even though|still|should|could|might|but|yet|never|didn.t|does not|doesn.t|failed to|missed)\b/i.test(
          unit,
        ) && !/\?\s*$/.test(unit),
    );
  const nouns = {
    build: "builds?",
    gate: "pnpm (?:check|verify)",
    lint: "lint(?:ing|er)?",
    test: "tests?|test suite|suite|smoke|unit tests?",
    typecheck: "typechecks?|type-checks?|tsc",
  };
  return Object.entries(nouns)
    .filter(([, noun]) =>
      units.some((unit) =>
        new RegExp(
          `\\b(?:${noun})\\b[^.]{0,40}(?:pass|green|clean|succeed|no errors|zero errors)|\\b(?:passes|passed|passing|green|clean|succeeds|succeeded)[^.]{0,25}\\b(?:${noun})\\b`,
          "i",
        ).test(unit),
      ),
    )
    .map(([family]) => family)
    .sort();
}

function telemetryRecord(payload, state) {
  const reasons = new Set(state.reasons);
  const turnEvent = payload.hook_event_name === "Stop";
  const turnKnown = typeof payload.turn_id === "string" && state.turns.has(payload.turn_id);
  const commands = turnEvent
    ? state.commands.filter((item) => item.turn === payload.turn_id)
    : state.commands;
  const activities = turnEvent
    ? state.activities.filter((item) => item.turn === payload.turn_id)
    : state.activities;
  const coverage = commands.length > 0 || activities.length > 0;
  const measured = state.reasons.length === 0 && (!turnEvent || turnKnown) && coverage;
  if (!coverage) reasons.add("observation-coverage-unavailable");
  if (turnEvent && !turnKnown) reasons.add("turn-unresolved");
  const agents = new Set(activities.map((item) => item.id).filter((id) => typeof id === "string"));
  if (measured && agents.size) reasons.add("subagent-commands-unavailable");
  reasons.add("subagent-dispatch-semantics-unavailable");
  const record = {
    v: 1,
    runtime: "codex",
    event: turnEvent ? "turn" : "session",
    date: new Date().toISOString(),
    session_id: typeof payload.session_id === "string" ? payload.session_id : null,
    turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    measured,
    main_commands: measured ? commands.length : null,
    successful_commands: measured ? commands.filter((item) => item.successful).length : null,
    subagent_dispatches: null,
    subagent_threads_observed: measured ? agents.size : null,
    subagent_commands: measured && agents.size === 0 ? 0 : null,
    compactions: measured ? state.compactions : null,
    skills_loaded: state.allSkills.size ? [...state.allSkills].sort() : null,
    degraded: [...reasons].sort(),
  };
  if (!state.allSkills.size) record.degraded.push("skill-load-evidence-unavailable");
  if (turnEvent) {
    const families = claims(payload.last_assistant_message);
    const evidence = commands
      .filter((item) => item.successful)
      .map((item) => checkFamilies(item.command));
    const evidenceComplete = evidence.every((item) => item !== null);
    if (!evidenceComplete) record.degraded.push("check-evidence-unrecognized");
    const backed =
      families?.filter((family) => evidence.some((item) => item?.includes(family))) ?? null;
    if (families === null) record.degraded.push("assistant-message-unavailable");
    Object.assign(record, {
      claim_families: families,
      backed_in_main: measured ? backed : null,
      backed_in_subagent: measured && agents.size === 0 ? [] : null,
      unbacked_families:
        measured && evidenceComplete && agents.size === 0 && families
          ? families.filter((family) => !backed.includes(family))
          : null,
      guidance_skill_invoked: [...state.allSkills].some(
        (skill) => skill === "writing-docs" || skill === "composing-context",
      )
        ? true
        : null,
      stop_hook_active:
        typeof payload.stop_hook_active === "boolean" ? payload.stop_hook_active : null,
    });
  } else {
    Object.assign(record, {
      end_reason: typeof payload.reason === "string" ? payload.reason : null,
      skill_tool_calls: null,
      touched_browser_surface: null,
      browser_surfaces_touched: null,
      dispatched_browser_verifier: null,
      touched_lab_only: null,
    });
    record.degraded.push(
      "file-edits-and-agent-roles-unavailable",
      "skill-invocation-tool-unavailable",
    );
  }
  return record;
}

export function handleHook(payload, options = {}) {
  if (!payload || typeof payload !== "object") return null;
  const event = payload.hook_event_name;
  if (!["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].includes(event)) return null;
  const state = transcriptState(payload.transcript_path, payload.cwd);
  if (event === "UserPromptSubmit" || event === "PostToolUse")
    return reminderOutput(payload, state, options);
  const record = telemetryRecord(payload, state);
  const directory = typeof payload.cwd === "string" ? join(payload.cwd, ".notes") : null;
  const target =
    options.telemetryFile ??
    process.env.UNIMATRIX_CODEX_TELEMETRY_FILE ??
    (directory && existsSync(directory) ? join(directory, "codex-session-log.jsonl") : null);
  if (!target) {
    options.warn?.(
      "codex-hooks: telemetry skipped; no existing .notes directory or configured output.",
    );
    return null;
  }
  try {
    appendFileSync(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    options.warn?.("codex-hooks: telemetry output unavailable; hook remains nonblocking.");
  }
  return null;
}

export function handleInput(input, options = {}) {
  if (typeof input !== "string" || Buffer.byteLength(input) > LIMIT) {
    options.warn?.("codex-hooks: input-too-large; hook skipped.");
    return null;
  }
  const payload = parsedJson(input);
  if (!payload || typeof payload !== "object") {
    options.warn?.("codex-hooks: malformed payload; hook skipped.");
    return null;
  }
  return handleHook(payload, options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = boundedRead(0);
    if (input.error) process.stderr.write(`codex-hooks: ${input.error}; hook skipped.\n`);
    else {
      const output = handleInput(input.text, {
        warn: (message) => process.stderr.write(`${message}\n`),
      });
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch {
    process.stderr.write("codex-hooks: hook failed; operation remains nonblocking.\n");
  }
}
