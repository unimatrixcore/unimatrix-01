---
name: composing-context
description: Decide where agent-facing guidance goes and how much of it to write — AGENTS.md vs a skill vs a reference file, rules vs judgement, what to defer. Use when writing or restructuring a skill, an AGENTS.md, a tool description, or any instruction an agent will load rather than a human will read. Not for prose quality inside a file (that is writing-docs) and not for trimming an existing file (that is a separate audit).
---

# Composing context for an agent

A prompt is written for one request. Context is loaded across many, so it cannot be as specific — and
every line of it is paid for on every session that loads it, including after each compaction.

`writing-docs` governs how a line is written. This governs whether the line should exist and which
file it belongs in.

## The failure this prevents

**Overlapping instructions cost reasoning before they cost tokens.** When a system prompt says "leave
documentation as appropriate" and a skill says "DO NOT add comments", the model must reconcile them
before it can act. Two rules that merely *overlap* are worse than one rule that is slightly wrong,
because the conflict is invisible in each file on its own.

So before adding a line anywhere, grep for the subject across `AGENTS.md` and `.agents/skills/`. If
something already covers it, edit that. A second statement of the same rule is not reinforcement.

## Prefer judgement to rules

Write the constraint and what breaks without it, then stop. Do not enumerate the cases.

- "Default to no comments. Never write multi-line comment blocks." ← over-constrains; wrong whenever
  the code is genuinely subtle
- "Write code that reads like the surrounding code: match its comment density, naming, and idiom."
  ← the replacement Anthropic actually shipped

Hard rules still earn their place where a mistake is silent, expensive, or irreversible — never push
to `main`, never print a credential, never merge past a red check. Reserve the imperative for those
and let judgement cover the rest. A rule that is right 80% of the time costs more than it saves,
because the model cannot tell which 20% it is in.

## Design the interface instead of giving examples

Examples constrain the model to the space they demonstrate. Where you are tempted to write one, ask
whether the *thing being described* can carry the meaning instead — a parameter named for its
intent, an enum whose values state the allowed states, a script whose `--help` is the documentation.

Keep an example only where it encodes something the interface cannot: an exact string to grep for, a
command whose flags are non-obvious, a shape that is genuinely surprising.

## Put it where it is needed, not where it is findable

Four layers, in order of how often they are paid for:

| Layer | Holds | Cost |
| --- | --- | --- |
| `AGENTS.md` | gotchas and live constraints for this repo | every session |
| Skill | one opinionated procedure, loaded when invoked | per invocation |
| Reference file beside a skill | the conditional part of that procedure | per read |
| Code, tests, fixtures | the spec itself | when opened |

The instinct to make one file the place everything lives is the thing to resist. But **deferral is
not free, and it is not always a saving** — this is where local judgement beats the general advice:

- Splitting pays when the content is **conditional** — a recovery procedure for a failure most runs
  never hit, a platform-specific branch. Most sessions genuinely never load it.
- Splitting pays nothing when the content is merely **later**. If the procedure always reaches that
  phase, the file is always read, and you have added a tool call, a pointer, and a second place for
  the rule to drift out of sync.
- A pointer is also a step that can be skipped, in the same class as a skill that does not
  auto-activate. Weaker, but real.

So: **trim before you split.** Moving 200 lines that are always read saves nothing; deleting 80 lines
of provenance saves 80 lines on every session.

## Let the tools own their own instructions

Instructions about a tool belong in that tool's description, not repeated in the file that mentions
it. Repetition existed because older models weighted the end of the context window more heavily; it
is now just two places to update.

The same holds for memory. Auto-memory captures what is durable about the user and the work — do not
hand-maintain a parallel copy in a committed file.

## Prefer references in the language the model already knows

A spec can be a failing test, a type definition, a working function in another codebase, an HTML
mockup. All of them are higher-fidelity than prose describing the same thing, and none of them drift
away from the behaviour, because they *are* the behaviour.

Reach for prose when the thing to convey is a *reason* — why an ordering prevents a silent no-op, why
a ceiling exists. Reasons have no executable form; everything else usually does.

## Before you commit the change

- Does any line duplicate one in `AGENTS.md` or another skill? Delete one of them.
- Would deleting the line change what someone does? If not, delete it.
- Is it a rule where judgement would do — and is this one of the silent-failure cases that earns a
  rule?
- If you deferred something, is it conditional, or merely later?
