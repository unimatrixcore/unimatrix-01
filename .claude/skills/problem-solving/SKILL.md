---
name: problem-solving
description: How to work a problem in this repo before proposing a fix — separate the concerns, name the binding constraint, check the world before inventing, fan out to the problems nobody raised, then converge on one recommendation. Use for any question of the form "how should we", "why does", "what are the options", "is X the right approach", and before any change whose shape is not already obvious.
---

# Working a problem

In Codex, read `.claude/runtime.md` for dispatch and usage controls. The Claude budget observations
below do not measure Codex usage. An owner's explicit request for delegation already opts in.

The failure this exists to prevent: a plausible answer to the wrong question, delivered fast, with no
web check and no mention of the adjacent problems that were visible along the way. The owner should
not have to ask "did you research this?" or "what else should I be considering?" — if those
questions are still worth asking when you finish, you skipped a stage.

Five stages. Do them in order and say which one you are in.

## 1. Separate the concerns

Write down every distinct problem in what was asked, one line each, before solving any of them.

Two things fall out that never fall out of solving directly: problems that look like one problem and
are two (a rename *and* a deploy-config change), and problems that look like two and are one (four
symptoms of a single stale cache). Getting that wrong is the most expensive mistake available here,
because it decides how many things you are about to build.

Then say which ones you are working and which you are not. A concern you have consciously parked is
information; a concern you silently dropped is a gap the owner discovers later.

## 2. Name the binding constraint

For each problem you kept: what actually makes this hard? Not the symptom — the thing that would have
to change for the problem to disappear.

State it as *what would have to be true*. "The port must be stable because the API's CORS allowlist is
a static list" is a constraint. "Ports are confusing" is a symptom. A constraint you can name is a
constraint you can attack directly, and it is usually the thing that rules out most of the option
space in one line.

Distinguish the constraints that are real from the ones that are only current. "We can't upgrade
TypeScript because `typescript-eslint` caps it" is real and dated — it lifts when upstream widens the
range. "We do it this way because we always have" is not a constraint at all.

## 3. Check the world before inventing

**Search the web before proposing anything**, not after being asked. There is exactly one problem
shape that does not need it — one wholly internal to this repo, where nothing upstream could bear on
the answer. Skipping is therefore a *claim*, and it has to be written down as one: name the problem
as internal and say why. Silence is what this rule forbids, not the skip.

What to look for, in order of what it saves:

- **Does this already exist?** A plugin, an MCP server, an upstream flag, a builtin command. Building
  a thing that already ships is the most wasteful outcome available. Check before designing.
- **Has someone hit this and written it down?** An upstream issue, a changelog entry, a post-mortem.
  The answer to "why does this behave like that" is very often already published.
- **Is the belief this rests on still true?** Version-specific behaviour, deprecations, a default that
  changed. Anything remembered rather than read is a hypothesis.

Then check the world *inside* the repo, which is the higher-authority source when the two disagree:
run the command, read the config, reproduce the behaviour. **What the system does beats what any
document says about it, including upstream docs.** When observed behaviour contradicts a source you
trusted, find what the source got wrong rather than explaining the contradiction away.

Label every claim by how you know it: measured, read, or assumed.

## 4. Fan out

Generate options — plural — and include the ones the question did not ask for.

- At least one option that attacks the constraint from stage 2 rather than working around it.
- At least one that is smaller than the ask: what if we do nothing, or the cheapest thing that makes
  the failure loud instead of silent?
- The problems **nobody raised.** This is the part the owner has to ask for today, so it is the part
  to make automatic. While working the stated problem you will pass things that are wrong for other
  reasons — a doc that contradicts itself, a check that cannot fail, a second copy of a value. Note
  them. They do not all become work; unraised problems that go unmentioned become the next incident.

Keep this cheap and wide. Options are for discarding — the expensive mistake is having only one.

## 5. Converge

One recommendation, with the alternatives visible and a reason each was not chosen. Not a survey:
what is scarce is the owner's hands-on time, not the ability to follow the reasoning — so give the
trade-offs at full depth and then say what you would do.

Every recommendation carries:

- **What would change your mind.** The observation that would make this the wrong call.
- **What you could not verify.** Plainly.
- **Whose call it is.** Dependency, tooling and architectural choices are the owner's — present
  options with a recommendation, do not decide them. Everything else, decide and report.

## When to propose a workflow instead

The last stage can be a fan-out across agents, but **a workflow is opt-in: propose it, do not launch
it.** Give the scope, the shape (how many agents doing what), and a rough cost, then wait.

Propose one when **two or more** of these hold:

- the survey does not fit one context — more than roughly five subsystems, or a sweep across every
  workspace
- three or more options each need real research before they can be compared
- getting it wrong is expensive to unwind — auth, data loss, anything deployed
- the work is mechanically repetitive over a known list (one agent per item), so parallelism is the
  whole value

One problem with one obvious place to look is not a workflow, however interesting it is.

Two conditions is the bar because a single one is usually just "this is a bit big", and a fan-out is
expensive in a currency that reports no balance: it spends the owner's rolling five-hour window and
weekly limit, neither of which shows a remaining figure at the call site. Upstream classes a run as
large at 25 agents or 1.5M projected tokens and advises running it on a small slice first; measured
here, one seventeen-agent review run had reached 688.6k tokens by its fifth agent. Two-of-four is a
house rule fitted to those numbers, not an upstream recommendation.
