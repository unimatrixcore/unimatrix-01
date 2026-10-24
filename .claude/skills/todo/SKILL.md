---
name: todo
description: Compose a `.notes/01-todo/*.todo.md` item. Use when asked to add or extend a todo item. Carries when to write the item solo and when to compose it with the owner turn by turn, what a task may and may not contain, and the citation convention and its resolver.
---

# Compose a todo item

In Codex, read `.claude/runtime.md` for explicit skill loading; do not rely on Claude's context
injection or compaction behavior.

## Before you write anything

Read `.notes/AGENTS.md` — it owns the format. `.notes/` is gitignored, so a fresh clone has this
skill without it; if it's missing, stop and tell the user the format contract is missing rather than
guessing at one. Scaffolding a new file may not trigger that directory's auto-load, and the
injection doesn't survive a `/compact`, so don't trust it to already be in context. If the target
file already exists, run
`node infra/scripts/resolve-todo-citations.mjs <file>` first and surface anything it reports as
`STALE` verbatim before writing anything else.

## Never pick the architecture, and never write a task the owner hasn't settled

Both fail silently — a task written from a guess reads exactly like one the owner chose. This holds
on both paths below. Composing solo means investigating and drafting without a stop between each
step; it never means choosing the shape of the change.

## Solo by default

Investigate the whole item and write it in one pass. Stopping between the steps costs a turn each
time, and on an item the owner has already specified those turns only confirm what their first
message said.

What sends it to the loop instead is **discovered, not judged up front** — so investigate first,
then decide. Investigation answers questions of *fact* from the code. What it cannot answer is a
*requirement*: something the code has no opinion on and the owner hasn't settled — two viable
designs, a dependency to pick, a boundary to move. One live requirement is enough — but you have to
be able to name the decision it turns on. An unease that won't resolve into a named decision goes
back to investigation, not to the loop, and never into a written task.

The owner can also ask for the loop outright — `/todo --collab`, or in any other words — and owes no
reason for it.

## The loop, when a requirement is live

1. **Scaffold.** Title, empty Description, empty Tasks. Stop.
2. **Investigate the whole item.** What shape this change is, not how to build it: current state,
   answers to whatever the owner attached, and options for every live requirement. Bring it back.
   Stop.
3. **Per task, repeat:** the owner names the next task; investigate scoped to that task only; bring
   options; the owner chooses; write the task. Stop after every investigation.

## What a task is

One logical, independently shippable commit — the task line itself is the conventional-commit
message. Sub-bullets carry constraints, TBDs, and decisions already settled, never implementation
detail: `monorepo-implementer` reads a task through `ship-pr` and re-derives the *how* from the
code, so a *how* written here is a guess it will follow rather than question.

## The description

Readable without opening a single referenced file: what's wrong now, what becomes true, and the
constraint that rules out the obvious alternative.

## Citations

`.notes/AGENTS.md` owns the format; this adds only what it doesn't say. Cite by letter inline in
the Description/Tasks prose at the point it's relevant. Add `:line` only when the line itself is
the point rather than the file — every `:line` is one more citation `resolve-todo-citations.mjs`
has to keep resolving.

A citation lives only in a References entry, never inline as a backticked `path:line` in prose —
the resolver only resolves entries inside a References block, and reports an inline one
(`INLINE`) rather than fixing it. A References entry isn't only a path: it can also be a PR or a
link — see `.notes/AGENTS.md` for the permitted forms.
