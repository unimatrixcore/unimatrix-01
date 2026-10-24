---
name: writing-docs
description: How this repo wants documentation written — any .md file, AGENTS.md, README, code comment, docstring, or PR body. Use when adding or changing prose that a human or an agent will read as guidance, and when auditing existing docs for drift, noise, or claims that are no longer true.
---

# Writing docs in this repo

In Codex, read `.claude/runtime.md` for skill loading. `/doctor` and the Claude measurements below
refer to Claude Code.

Two audiences, one failure mode: a human who skims and an agent that loads the file into a
finite context and acts on it. Both are hurt by stale claims, by narration of past work, and by
prose that costs attention without changing a decision.

The test for a line is **would deleting it change what someone does?**

This skill governs **how a line is written**. Whether it should exist at all, and which file or layer
holds it, is `composing-context` — reach for that when editing an `AGENTS.md`, a skill, or a tool
description. Both fire on those files and they do not overlap: structure and placement there, wording
here.

## What this repo is opinionated about

**Current state and live constraints only.** Not what it used to be, not who found the bug, not
which PR changed it — git holds that. The exception is a rule whose reason is only visible in
what went wrong: a compatibility fallback, a dependency ceiling, an upstream workaround. Write
the constraint and what breaks without it, not the incident.

**Don't restate what can't drift.** The dependency list, the script names, the schema, the
workspace roster. A committed copy of something `ls` answers is worse than nothing: it goes
stale silently and gets believed anyway. Point at the source.

**Don't document absence,** and don't write a doc about another doc — no file explaining what a
neighbouring file contains, no instructions for maintaining the index being read.

**Prefer the thing that will bite** over the accurate summary. "Two resolved copies of the
router means `useRouterState` reads a context the provider never wrote to" earns its line;
"this package holds the shared UI components" does not.

**Label what you did not verify.** An unmarked guess about *why* something behaves as it does is
the most damaging thing a reference doc can contain. If you did not run it, say so.

**Delete stale text; don't append a correction beside it.**

**Read the whole file before changing one line of it, and grep the repo for the subject first.**
This is the single most productive rule here, because the contradictions this repo actually shipped
were mostly *local*: one file called `auth-boundary.tsx` a route gate and denied it sixteen lines
later; one README banned a `?raw` import on the line directly below the one documenting a `?raw`
import; one checklist told authors to create a markdown file that two sections above it said to
create through the admin surface. None needed repo-wide knowledge to catch — only reading past the
line being edited. Nothing mechanical catches this class, so it is on you.

**A claim about observable behaviour states what the check returned, not what you believe.** Where
two documents disagree, prose cannot break the tie and the reader has no way to tell which side is
stale — so anchor the claim to something re-runnable: what `curl` returns, what the ruleset lists,
what the script prints. This repo has already lost a *true* statement to a confident wrong one that
sat in a neighbouring file; the one that survived was the one carrying its evidence.

## The drifts this repo actually had

Each was written by someone being helpful, and each became a lie within weeks. When you catch
yourself about to do one, don't. The incidents stay because each is the only thing that makes its
rule concrete — they are the exception above, not licence to narrate elsewhere.

**Never commit a count of anything the filesystem knows.** "Create four Dokploy services" survived
into five; "the four applications under `apps/`" left one deployed app outside the security policy.
Write the glob or the derivation — "one service per `infra/docker/*-compose.yaml`" — not the number.

**Never paste a list the code owns; point at the file.** A copy of
`DEFAULT_API_CORS_ALLOWED_ORIGINS` drifted by four entries, a hand-written frontmatter schema was
thinner than `parsers.ts`, and `nginx:1.29-alpine` was pinned at `1.31`. If a reader could `grep` it,
name where to grep. A committed copy is a second source of truth that nothing reconciles.

**Never describe shipped work as future, or a change as recent.** "(later phase)", "now exists",
"no longer", "for now" — six places marked live wiring as unbuilt, which invites a second
implementation instead of reuse. Write the present tense; git holds the history.

**When you claim a safety net, name the check that provides it.** Two files said a trap was caught
by "nothing but a browser" while `check-app-wiring.sh` failed closed on it, and
`packages/db/AGENTS.md` said "nothing in CI would catch this" while `Images (api)` did. An
overstated gap is as costly as a missed one — it gets budgeted for.

**When you delete a mechanism, grep for its name first.** An "occluder" system was removed and five
comments across four workspaces survived it, three of them the only stated reason a wrapper element
existed. `pnpm check:stale-comments` now catches this class.

For code comments, follow the surrounding file's comment density and idiom. Where a comment is
worth writing, it earns its place by saying what the code cannot say about itself. An invariant
worth explaining is usually worth asserting instead.

## Length is a per-session cost

Terseness here is empirical, not taste. Anthropic removed over 80% of Claude Code's system
prompt for the Claude 5 generation with no measurable loss on their coding evals, and found that
overlapping or conflicting instructions make a model reason about reconciling them before it can
act. [Gloaguen et al.](https://arxiv.org/abs/2602.11988) measured agents on real tasks with no
context file, a generated one, and a human-written one: generated files made agents *worse*
(−2% resolution on their benchmark, 2.5× more repo-tool calls, over-exploration of the tree),
while hand-written ones gave about +4%. Their conclusion was to carry only indispensable
operational constraints and skip architectural overviews.

So: put gotchas in `AGENTS.md`, push detail into a skill that loads when it is relevant, and
resist the urge to make any one file the place where everything lives. `/doctor` proposes trims
for a checked-in `CLAUDE.md`, cutting what is derivable from the codebase and keeping pitfalls and
rationale (Claude Code 2.1.206+).

## Structure

[Diátaxis](https://diataxis.fr/) is the reference if a file's shape is unclear — it separates
tutorial, how-to, reference, and explanation by what the reader is doing. `AGENTS.md` files and
most READMEs here are reference plus constraints: scannable, factual, with the *why* attached in
one sentence to the rule it justifies.
