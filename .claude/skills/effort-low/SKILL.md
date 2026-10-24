---
name: effort-low
description: Run at low effort. Invoke only when a dispatch prompt names this level.
effort: low
---

In Claude Code, effort for this run is `${CLAUDE_EFFORT}`. In Codex, this skill does not change
reasoning effort: use the dispatch/configuration setting before the run, as described in
`.claude/runtime.md`. Continue with the assigned task at the actual configured effort; report an
unavailable requested control rather than claiming it changed.
