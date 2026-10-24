import assert from "node:assert/strict";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { syncCodexContext } from "./sync-codex-context.mjs";

function interceptOpen(t, implementation) {
  const original = fs.open;
  t.mock.method(fs, "open", (...args) => implementation(original, ...args));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, ".claude/runtime.md", "# Runtime\nRead canonical roles.\n");
  await put(
    root,
    ".claude/skills/writing/SKILL.md",
    "---\nname: writing\ndescription: Write guidance.\n---\nApply this skill.\n",
  );
  await put(
    root,
    ".claude/agents/planner.md",
    "---\nname: planner\ndescription: Plan a change.\nmodel: sonnet\neffort: high\nskills:\n  - writing\n---\nRead only.\n",
  );
  await put(
    root,
    ".claude/settings.json",
    JSON.stringify({
      hooks: Object.fromEntries(
        Object.entries({
          PostToolUse: ["writing-docs-reminder.sh", "composing-context-reminder.sh"],
          UserPromptSubmit: ["problem-solving-reminder.sh"],
          Stop: ["turn-telemetry.sh"],
          SessionEnd: ["session-telemetry.sh"],
        }).map(([event, handlers]) => [
          event,
          [
            {
              ...(event === "PostToolUse" ? { matcher: "Write|Edit" } : {}),
              hooks: handlers.map((name) => ({
                type: "command",
                command: `bash "\${CLAUDE_PROJECT_DIR:-.}/infra/scripts/${name}"`,
                timeout: 10,
              })),
            },
          ],
        ]),
      ),
    }),
  );
  return root;
}

test("discovers roles and skills, preserves effort, inherits models, and reads canonical instructions", async (t) => {
  const root = await fixture(t);
  await put(
    root,
    ".claude/skills/research/SKILL.md",
    "---\nname: research\ndescription: Research carefully.\n---\nInvestigate.\n",
  );
  await put(
    root,
    ".claude/agents/researcher.md",
    "---\nname: researcher\ndescription: Research a change.\n---\nInvestigate without editing.\n",
  );
  assert.equal(await syncCodexContext({ sourceRoot: root }), 5);
  const planner = await readFile(join(root, ".codex/agents/planner.toml"), "utf8");
  assert.match(planner, /model_reasoning_effort = "high"/);
  assert.doesNotMatch(planner, /^model =/m);
  assert.match(planner, /\.claude\/runtime\.md/);
  assert.match(planner, /\.claude\/agents\/planner\.md/);
  assert.match(planner, /\.claude\/skills\/writing\/SKILL\.md/);
  assert.doesNotMatch(planner, /Read only\./);
  assert.doesNotMatch(
    await readFile(join(root, ".codex/agents/researcher.toml"), "utf8"),
    /model_reasoning_effort/,
  );
  assert.equal(
    await readlink(join(root, ".agents/skills/research")),
    "../../.claude/skills/research",
  );
  assert.equal(
    await realpath(join(root, ".agents/skills/research")),
    join(root, ".claude/skills/research"),
  );
  assert.equal(await syncCodexContext({ sourceRoot: root, check: true }), 0);
  assert.equal(await syncCodexContext({ sourceRoot: root }), 0);
});

test("stages relative skill links that resolve to canonical sources", async (t) => {
  const root = await fixture(t);
  const stage = await mkdtemp(join(tmpdir(), "codex-stage-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await syncCodexContext({ sourceRoot: root, outputRoot: stage });
  assert.equal(
    await realpath(join(stage, ".agents/skills/writing")),
    join(root, ".claude/skills/writing"),
  );
  assert.ok(!(await readlink(join(stage, ".agents/skills/writing"))).startsWith("/"));
  await syncCodexContext({ sourceRoot: root, outputRoot: stage, check: true });
});

test("renders native hook events, matchers and timeouts", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  const { hooks } = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks), ["PostToolUse", "SessionEnd", "Stop", "UserPromptSubmit"]);
  assert.equal(hooks.PostToolUse[0].matcher, "^apply_patch$");
  for (const [event, entries] of Object.entries(hooks)) {
    assert.equal(entries[0].hooks[0].timeout, event === "SessionEnd" ? 3 : 10);
    assert.equal(
      entries[0].hooks[0].command,
      'node "$(git rev-parse --show-toplevel)/infra/scripts/codex-hooks.mjs"',
    );
  }
});

test("missing outputs and metadata changes fail check without writing, then regenerate owned files", async (t) => {
  const root = await fixture(t);
  await assert.rejects(syncCodexContext({ sourceRoot: root, check: true }), /Codex context drift/);
  await syncCodexContext({ sourceRoot: root });
  const source = join(root, ".claude/agents/planner.md");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("Plan a change.", "Plan another change."),
  );
  await assert.rejects(syncCodexContext({ sourceRoot: root, check: true }), /planner\.toml/);
  assert.doesNotMatch(await readFile(join(root, ".codex/agents/planner.toml"), "utf8"), /another/);
  await syncCodexContext({ sourceRoot: root });
  assert.match(await readFile(join(root, ".codex/agents/planner.toml"), "utf8"), /another/);
});

test("rejects malformed frontmatter and absent preload skills", async (t) => {
  const root = await fixture(t);
  const path = ".claude/agents/planner.md";
  for (const content of [
    "No frontmatter.",
    "---\nname: wrong\ndescription: Wrong name.\n---\nBody.\n",
    "---\nname: planner\ndescription: |\n  Unsupported block.\n---\nBody.\n",
    "---\nname: planner\ndescription: First.\ndescription: Duplicate.\n---\nBody.\n",
    "---\nname: planner\ndescription: Broken effort.\neffort: extreme\n---\nBody.\n",
    "---\nname: planner\ndescription: Missing skill.\nskills:\n  - missing\n---\nBody.\n",
  ]) {
    await put(root, path, content);
    await assert.rejects(syncCodexContext({ sourceRoot: root }));
  }
});

test("rejects missing runtime, invalid skills and newly unhandled hook events", async (t) => {
  const root = await fixture(t);
  await rm(join(root, ".claude/runtime.md"));
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /runtime\.md/);
  await put(root, ".claude/runtime.md", "Runtime.");
  await put(root, ".claude/settings.json", JSON.stringify({ hooks: { NewEvent: [{}] } }));
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Unhandled Claude hook events/);
  await put(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{}] } }));
  await put(root, ".claude/skills/writing/SKILL.md", "---\ndescription: Missing name.\n---\nBody.");
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /name must match/);
});

test("never replaces user-owned files, conflicting links, or symlinked output directories", async (t) => {
  const root = await fixture(t);
  await put(root, ".codex/agents/planner.toml", "User content.");
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing unowned/);
  assert.equal(await readFile(join(root, ".codex/agents/planner.toml"), "utf8"), "User content.");
  await rm(join(root, ".codex/agents/planner.toml"));
  await mkdir(join(root, ".agents/skills"), { recursive: true });
  await symlink("../../elsewhere", join(root, ".agents/skills/writing"));
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing conflicting skill link/);
  assert.equal(await readlink(join(root, ".agents/skills/writing")), "../../elsewhere");
  await rm(join(root, ".agents"), { recursive: true });
  await symlink(".claude", join(root, ".agents"));
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing non-directory/);
});

test("reports stale owned outputs without deleting them or touching unrelated registrations", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  await put(root, ".codex/agents/custom.toml", "User registration.");
  await put(
    root,
    ".codex/agents/stale.toml",
    await readFile(join(root, ".codex/agents/planner.toml"), "utf8"),
  );
  await assert.rejects(syncCodexContext({ sourceRoot: root, check: true }), /Stale managed output/);
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Stale managed output/);
  await rm(join(root, ".codex/agents/stale.toml"));
  await symlink("../../.claude/skills/removed", join(root, ".agents/skills/removed"));
  await assert.rejects(syncCodexContext({ sourceRoot: root, check: true }), /Stale managed output/);
  assert.equal(
    await readFile(join(root, ".codex/agents/custom.toml"), "utf8"),
    "User registration.",
  );
});

test("refuses unowned hook config and non-file agent outputs", async (t) => {
  const root = await fixture(t);
  await put(root, ".codex/hooks.json", JSON.stringify({ hooks: {} }));
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing unowned/);
  await rm(join(root, ".codex/hooks.json"));
  await mkdir(join(root, ".codex/agents/planner.toml"), { recursive: true });
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing non-file/);
});

test("fails when an existing Claude event gains an unhandled handler or matcher", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".claude/settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  settings.hooks.Stop[0].hooks.push({ type: "command", command: "new-handler", timeout: 10 });
  await writeFile(path, JSON.stringify(settings));
  await assert.rejects(
    syncCodexContext({ sourceRoot: root }),
    /Unhandled Claude hook registration or handler: Stop/,
  );
  settings.hooks.Stop[0].hooks.pop();
  settings.hooks.PostToolUse[0].matcher = "Write|Edit|NewTool";
  await writeFile(path, JSON.stringify(settings));
  await assert.rejects(
    syncCodexContext({ sourceRoot: root }),
    /Unhandled Claude hook registration or handler: PostToolUse/,
  );
});

test("refuses agent and hook leaf symlinks without modifying their targets", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  const victim = join(root, "user-file.txt");
  await writeFile(victim, "User content.");
  for (const name of [".codex/agents/planner.toml", ".codex/hooks.json"]) {
    const path = join(root, name);
    const previous = await readFile(path, "utf8");
    await rm(path);
    await symlink(victim, path);
    await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing non-file/);
    assert.equal(await readFile(victim, "utf8"), "User content.");
    await rm(path);
    await writeFile(path, previous);
  }
});

test("exclusive creation preserves a user file appearing after the missing-file read", async (t) => {
  const root = await fixture(t);
  const target = join(root, ".codex/agents/planner.toml");
  await mkdir(dirname(target), { recursive: true });
  let raced = false;
  interceptOpen(t, async (original, path, flags, mode) => {
    if (path === target && !raced && !(flags & constants.O_CREAT)) {
      raced = true;
      try {
        return await original(path, flags, mode);
      } catch (error) {
        assert.equal(error.code, "ENOENT");
        await writeFile(target, "User file appeared.");
        throw error;
      }
    }
    return original(path, flags, mode);
  });
  await assert.rejects(syncCodexContext({ sourceRoot: root }), { code: "EEXIST" });
  assert.equal(raced, true);
  assert.equal(await readFile(target, "utf8"), "User file appeared.");
});

test("a symlink swapped in after ownership validation cannot redirect an update", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  const target = join(root, ".codex/agents/planner.toml");
  const source = join(root, ".claude/agents/planner.md");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("Plan a change.", "Changed plan."),
  );
  const victim = join(root, "user-file.txt");
  await writeFile(victim, "User content.");
  let raced = false;
  interceptOpen(t, async (original, path, flags, mode) => {
    const handle = await original(path, flags, mode);
    if (path === target && !raced && !(flags & constants.O_RDWR)) {
      const read = handle.readFile.bind(handle);
      handle.readFile = async (...args) => {
        const value = await read(...args);
        raced = true;
        await rm(target);
        await symlink(victim, target);
        return value;
      };
    }
    return handle;
  });
  await assert.rejects(syncCodexContext({ sourceRoot: root }), { code: "ELOOP" });
  assert.equal(raced, true);
  assert.equal(await readFile(victim, "utf8"), "User content.");
});

test("a pathname swap after opening the update descriptor cannot redirect its writes", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  const target = join(root, ".codex/agents/planner.toml");
  const source = join(root, ".claude/agents/planner.md");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("Plan a change.", "Changed plan."),
  );
  const victim = join(root, "user-file.txt");
  await writeFile(victim, "User content.");
  let raced = false;
  interceptOpen(t, async (original, path, flags, mode) => {
    const handle = await original(path, flags, mode);
    if (path === target && !raced && flags & constants.O_RDWR) {
      raced = true;
      await rm(target);
      await symlink(victim, target);
    }
    return handle;
  });
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Refusing non-file/);
  assert.equal(raced, true);
  assert.equal(await readFile(victim, "utf8"), "User content.");
});

test("concurrent edits to an owned file fail closed before overwriting them", async (t) => {
  const root = await fixture(t);
  await syncCodexContext({ sourceRoot: root });
  const target = join(root, ".codex/agents/planner.toml");
  const source = join(root, ".claude/agents/planner.md");
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("Plan a change.", "Changed plan."),
  );
  let raced = false;
  interceptOpen(t, async (original, path, flags, mode) => {
    const handle = await original(path, flags, mode);
    if (path === target && !raced && flags & constants.O_RDWR) {
      raced = true;
      await writeFile(target, "Concurrent user edit.");
    }
    return handle;
  });
  await assert.rejects(syncCodexContext({ sourceRoot: root }), /Output changed during/);
  assert.equal(raced, true);
  assert.equal(await readFile(target, "utf8"), "Concurrent user edit.");
});
