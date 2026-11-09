# Gamification API

Import pure helpers from `@unimatrix/ui/gamification`; this entry point loads no React code.
React consumers can import the same helpers and `GamificationStatus` from `@unimatrix/ui/public`.

Pass a stable, caller-scoped sample ID to `awardSample` only after the underlying save succeeds.
Keep the returned ledger: each ID earns once, including after `snapshotAwardLedger` and
`restoreAwardLedger` round trips. An action of `null` records no event. Set `previouslyReviewed`
when the source already records a completed sample. Reward values are configurable through
`ReviewRewardRules`; defaults live in `DEFAULT_REVIEW_REWARD_RULES`.

```ts
import { awardSample, createAwardLedger } from "@unimatrix/ui/gamification";

const result = awardSample(createAwardLedger(), {
  sampleId: "lesson:fractions:exercise:7",
  action: "save",
  label: "3/4",
  suggestionText: "2/4",
}, { acceptedPoints: 2, correctedPoints: 4, manualPoints: 3 });
```

Persist snapshots in the caller's storage. Restore functions accept parsed values and throw on
malformed IDs, pause reasons, negative numbers, nonfinite numbers, or unsafe numeric magnitudes.
Use `restoreSampleAward` to replay a persisted successful-save receipt when the corresponding
ledger snapshot did not finish saving; replaying its sample ID cannot award twice.

Create a reading clock with `createReadClock(nowMs)`. Supply timestamps from one clock origin.
`pauseReadClock` adds an editing, loading, paused, or idle blocker; `resumeReadClock` removes only
the named blocker. Clearing loading or manual pause cannot clear editing. Call
`readClockElapsedMs` to read time and `snapshotReadClock` before persisting. `restoreReadClock`
keeps frozen reasons and excludes time while the application was away. Start a fresh clock when
moving to a different sample. Award rules do not depend on elapsed time.

`GamificationStatus` accepts points, streak, elapsed time, clock state, and custom labels.
`ReviewSessionStatus` preserves review labels and the optional legacy score/timer/streak IDs.
IDs identify whole semantic fields so a mount-once DOM consumer can replace each complete field.

Import `GamificationEffectsLayer` and `ScoreFeedback` from `@unimatrix/ui/public` for
floating score and typing feedback. Native DOM consumers can attach
`createGamificationEffects(container)` to a positioned input wrapper. Call `emit` with points,
feedback kind, optional glyph and multiplier; call `clear` on a context change and `dispose`
when removing the host. The controller bounds queued and visible effects, escapes glyph text,
and respects reduced motion while retaining an accessible completion receipt.

Apply `um-game-theme` to a game surface for bright mint rewards, cyan combos, amber top-tier
feedback, and coral penalties. The palette is scoped to that surface; the surrounding shell
and grid retain their theme colors.

Shared styles use `um-game-input-group`, `um-game-input`, `um-game-combo`, `um-game-ghost`,
`um-game-crop`, and `um-game-highscore` on existing layout elements. The input group takes
`combo-x1`, `combo-x2`, `combo-x3`, or `combo-x5`; `warning` on the badge and `combo-warning`
on the input enable timed feedback. These classes own motion and token colors; the consumer
owns layout, reward rules and input validation.
