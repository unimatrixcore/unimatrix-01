---
name: ship-pr
description: Handle pull requests through review, required checks, findings and confirmed merge. Use when asked to open, review, update or merge a PR.
---

# Handling pull requests

Use the GitHub connector for PR operations when it provides the needed capability; use `gh` as a
fallback. Keep one PR per requested TODO item and one logical commit per individual task when the
owner requests that structure. Preserve existing work and never push directly to `main`.

Before opening a PR, describe the concrete problem, resulting behavior, checks actually run and
material limitations. Follow the repository template where one exists. Attach the created PR to
the task. Keep its title and body aligned with the final diff.

Request CodeRabbit on the finished PR with `@coderabbitai full review`. A passing bot check or an
acknowledgement is not a completed review. If CodeRabbit is rate limited, request real Codex Code
Review on that PR with `@codex review` and wait for its completed report on the current head. A
local review or subagent report does not substitute for that service review. If the service cannot
complete, report the blocker rather than treating silence as approval.

Read review comments, unresolved threads, advisory bot findings and code-scanning alerts. Fix
applicable findings, verify the changes, and reply with the resolution before resolving threads.
Explain a declined finding with evidence. Review relevant changes to the head rather than relying
on a review of superseded code.

Read effective required checks from GitHub's branch rules. Wait for every required context on the
current head; a missing, pending, cancelled or failing required check is not green. Do not disable
checks, lower thresholds or bypass a failure. Confirm there are no unresolved findings, merge
conflicts or outstanding required approvals before merging.

When the owner has authorized merging, use the repository's squash-only merge policy and pin the
expected head. Recheck state when the head or base changes. Confirm GitHub reports the PR merged
and record its merge commit before claiming success or cleaning up its branch/worktree. An armed
merge or an open watcher is not a confirmed merge. Preserve ignored files needed by the owner
before archiving a worktree.
