export interface ReviewRewardRules {
  readonly acceptedPoints: number;
  readonly correctedPoints: number;
  readonly manualPoints: number;
}

export const DEFAULT_REVIEW_REWARD_RULES: Readonly<ReviewRewardRules> = Object.freeze({
  acceptedPoints: 10,
  correctedPoints: 20,
  manualPoints: 15,
});

export interface ReviewRewardEvent {
  readonly action: "accept" | "save" | null;
  readonly label: string;
  readonly suggestionText?: string | null;
}

export interface AwardLedger {
  readonly points: number;
  readonly streak: number;
  readonly awardedSampleIds: readonly string[];
}

export interface SampleAwardEvent extends ReviewRewardEvent {
  readonly sampleId: string;
  readonly previouslyReviewed?: boolean;
}

export interface SampleAwardResult {
  readonly ledger: AwardLedger;
  readonly awarded: boolean;
  readonly pointsAwarded: number;
}

function nonnegative(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError(`${name} must be a finite nonnegative safe number`);
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
}

export function classifyReviewReward(
  event: ReviewRewardEvent,
  rules: ReviewRewardRules = DEFAULT_REVIEW_REWARD_RULES,
): number {
  nonnegative(rules.acceptedPoints, "acceptedPoints");
  nonnegative(rules.correctedPoints, "correctedPoints");
  nonnegative(rules.manualPoints, "manualPoints");
  if (event.action === null) return 0;
  if (event.action === "accept") return rules.acceptedPoints;
  if (event.suggestionText === null || event.suggestionText === undefined)
    return rules.manualPoints;
  return event.label === event.suggestionText ? rules.acceptedPoints : rules.correctedPoints;
}

export function createAwardLedger(seed: Partial<AwardLedger> = {}): AwardLedger {
  return restoreAwardLedger({
    points: seed.points ?? 0,
    streak: seed.streak ?? 0,
    awardedSampleIds: seed.awardedSampleIds ?? [],
  });
}

export function restoreAwardLedger(snapshot: unknown): AwardLedger {
  const value = record(snapshot);
  const points = nonnegative(value.points, "points");
  const streak = nonnegative(value.streak, "streak");
  if (!Number.isInteger(streak)) throw new RangeError("streak must be an integer");
  if (
    !Array.isArray(value.awardedSampleIds) ||
    !value.awardedSampleIds.every((id): id is string => typeof id === "string" && id.length > 0)
  )
    throw new TypeError("awardedSampleIds must contain nonempty strings");
  return Object.freeze({
    points,
    streak,
    awardedSampleIds: Object.freeze([...new Set(value.awardedSampleIds)]),
  });
}

export function snapshotAwardLedger(ledger: AwardLedger): AwardLedger {
  return restoreAwardLedger(ledger);
}

export function awardSample(
  ledger: AwardLedger,
  event: SampleAwardEvent,
  rules: ReviewRewardRules = DEFAULT_REVIEW_REWARD_RULES,
): SampleAwardResult {
  if (typeof event.sampleId !== "string" || event.sampleId.length === 0)
    throw new TypeError("sampleId must be nonempty");
  if (event.action === null || ledger.awardedSampleIds.includes(event.sampleId))
    return { ledger, awarded: false, pointsAwarded: 0 };
  const pointsAwarded = event.previouslyReviewed ? 0 : classifyReviewReward(event, rules);
  const next = createAwardLedger({
    points: nonnegative(ledger.points + pointsAwarded, "points"),
    streak: nonnegative(ledger.streak + (event.previouslyReviewed ? 0 : 1), "streak"),
    awardedSampleIds: [...ledger.awardedSampleIds, event.sampleId],
  });
  return { ledger: next, awarded: !event.previouslyReviewed, pointsAwarded };
}

export function restoreSampleAward(
  ledger: AwardLedger,
  receipt: { readonly sampleId: string; readonly points: number },
): SampleAwardResult {
  if (typeof receipt.sampleId !== "string" || receipt.sampleId.length === 0)
    throw new TypeError("sampleId must be nonempty");
  const pointsAwarded = nonnegative(receipt.points, "receipt points");
  if (ledger.awardedSampleIds.includes(receipt.sampleId))
    return { ledger, awarded: false, pointsAwarded: 0 };
  return {
    ledger: createAwardLedger({
      points: ledger.points + pointsAwarded,
      streak: ledger.streak + 1,
      awardedSampleIds: [...ledger.awardedSampleIds, receipt.sampleId],
    }),
    awarded: true,
    pointsAwarded,
  };
}

export type ReadClockPauseReason = "editing" | "loading" | "paused" | "idle";
export interface ReadClockSnapshot {
  readonly elapsedMs: number;
  readonly pauseReasons: readonly ReadClockPauseReason[];
}
export interface ReadClock extends ReadClockSnapshot {
  readonly startedAtMs: number | null;
}

const PAUSE_REASONS: readonly ReadClockPauseReason[] = ["editing", "loading", "paused", "idle"];

function validateReasons(value: unknown): readonly ReadClockPauseReason[] {
  if (
    !Array.isArray(value) ||
    !value.every((reason): reason is ReadClockPauseReason =>
      PAUSE_REASONS.includes(reason as ReadClockPauseReason),
    )
  )
    throw new TypeError("Invalid clock pause reasons");
  return Object.freeze([...new Set(value)]);
}

function clock(
  elapsedMs: number,
  startedAtMs: number | null,
  pauseReasons: readonly ReadClockPauseReason[],
): ReadClock {
  return Object.freeze({ elapsedMs, startedAtMs, pauseReasons: Object.freeze([...pauseReasons]) });
}

export function createReadClock(nowMs: number): ReadClock {
  return clock(0, nonnegative(nowMs, "nowMs"), []);
}

export function readClockElapsedMs(value: ReadClock, nowMs: number): number {
  nonnegative(nowMs, "nowMs");
  return nonnegative(
    value.elapsedMs + (value.startedAtMs === null ? 0 : Math.max(0, nowMs - value.startedAtMs)),
    "elapsedMs",
  );
}

export function pauseReadClock(
  value: ReadClock,
  reason: ReadClockPauseReason,
  nowMs: number,
): ReadClock {
  const reasons = validateReasons([...value.pauseReasons, reason]);
  return clock(readClockElapsedMs(value, nowMs), null, reasons);
}

export function resumeReadClock(
  value: ReadClock,
  reason: ReadClockPauseReason,
  nowMs: number,
): ReadClock {
  validateReasons([reason]);
  nonnegative(nowMs, "nowMs");
  if (!value.pauseReasons.includes(reason)) return value;
  const reasons = value.pauseReasons.filter((item) => item !== reason);
  return clock(value.elapsedMs, reasons.length === 0 ? nowMs : null, reasons);
}

export function snapshotReadClock(value: ReadClock, nowMs: number): ReadClockSnapshot {
  return Object.freeze({
    elapsedMs: readClockElapsedMs(value, nowMs),
    pauseReasons: validateReasons(value.pauseReasons),
  });
}

export function restoreReadClock(snapshot: unknown, nowMs: number): ReadClock {
  const value = record(snapshot);
  const elapsedMs = nonnegative(value.elapsedMs, "elapsedMs");
  const reasons = validateReasons(value.pauseReasons);
  nonnegative(nowMs, "nowMs");
  return clock(elapsedMs, reasons.length === 0 ? nowMs : null, reasons);
}
