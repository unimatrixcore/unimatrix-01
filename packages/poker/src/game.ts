export interface PokerGameScore {
  points: number;
  combo: number;
  maxCombo: number;
  autoCompletes: number;
  quickLabels: number;
}
export interface PokerGameCompletion {
  persisted: boolean;
  valid: boolean;
  discard: boolean;
  elapsedMs: number;
  label: string | null;
  previousLabel: string;
  previouslyReviewed: boolean;
  previouslyDiscarded: boolean;
  usedAutoComplete: boolean;
  newUsername: boolean;
}
export function pokerComboMultiplier(combo: number): number {
  return combo >= 20 ? 5 : combo >= 10 ? 3 : combo >= 5 ? 2 : 1;
}
export function scorePokerInput(
  state: PokerGameScore,
  kind: "typing" | "tab" | "delete",
  length: number,
  acceptable = true,
): PokerGameScore {
  if (!Number.isInteger(length) || length < 0) throw new Error("Invalid text length.");
  if (!acceptable || length === 0) return state;
  const rate = kind === "typing" ? 5 : kind === "tab" ? 7.5 : -10;
  const points = Math.round(rate * pokerComboMultiplier(state.combo) * length);
  return { ...state, points: Math.max(0, state.points + points) };
}
export function scorePokerCompletion(
  state: PokerGameScore,
  event: PokerGameCompletion,
): PokerGameScore {
  if (!event.persisted) return state;
  if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < 0)
    throw new Error("Invalid review time.");
  const labeled = event.previouslyReviewed || event.previousLabel.trim() !== "";
  const changed = event.label !== null && event.label !== event.previousLabel;
  if (event.valid && !event.discard && labeled && !changed) return state;
  if (event.discard && event.previouslyDiscarded && !changed) return state;
  const next = { ...state };
  if (event.valid && labeled && changed) {
    next.points = Math.max(0, next.points - 100);
    next.combo = 0;
  }
  const multiplier = pokerComboMultiplier(next.combo);
  let points = 0;
  if (event.discard) {
    if (event.elapsedMs < 5000) {
      if (event.elapsedMs < 1000) points = 20 * multiplier;
      next.combo += 1;
    } else next.combo = 0;
  } else if (event.valid) {
    if (event.elapsedMs < 5000) {
      next.combo += 1;
      if (event.usedAutoComplete) {
        points = 60 * multiplier;
        next.autoCompletes += 1;
      } else {
        points = 100 * multiplier;
        next.quickLabels += 1;
      }
    } else next.combo = 0;
    // The source returns at discovery, before updating its max-combo counter.
    if (event.label && event.newUsername) return { ...next, points: next.points + points + 50 };
  } else next.combo = 0;
  next.maxCombo = Math.max(next.maxCombo, next.combo);
  next.points += points;
  return next;
}
