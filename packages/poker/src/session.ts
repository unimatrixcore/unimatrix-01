import {
  pokerSessionSchema,
  type PokerFrame,
  type PokerSample,
  type PokerSession,
} from "@unimatrix/shared";
import { canonicalRegionId } from "./regions.js";
import { normalizeLabel, validateLabel } from "./labels.js";

export function emptySession(): PokerSession {
  return { frames: [], pool: [], currentIndex: 0, points: 0, streak: 0, elapsedMs: 0 };
}

export function appendFrame(session: PokerSession, frame: PokerFrame): PokerSession {
  if (session.frames.some((value) => value.key === frame.key)) return session;
  const seen = new Set(
    session.pool.map((sample) => `${canonicalRegionId(sample.regionId)}:${sample.phash}`),
  );
  const crops = frame.crops.filter((sample) => {
    const id = `${canonicalRegionId(sample.regionId)}:${sample.phash}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ...session,
    frames: [...session.frames, { ...frame, crops }],
    pool: [...session.pool, ...crops],
  };
}

export function decideSample(
  session: PokerSession,
  key: string,
  decision: PokerSample["decision"],
  label: string,
): PokerSession {
  const sample = session.pool.find((item) => item.key === key);
  if (!sample) throw new Error("Sample no longer exists in this session.");
  const normalized = decision === "label" ? normalizeLabel(sample.regionId, label) : "";
  if (decision === "label" && !normalized)
    throw new Error("Choose Blank explicitly for an empty region.");
  if (decision === "label") {
    const error = validateLabel(sample.regionId, normalized);
    if (error) throw new Error(error);
  }
  const decided = { ...sample, label: normalized, decision };
  return {
    ...session,
    pool: session.pool.map((item) => (item.key === key ? decided : item)),
    frames: session.frames.map((frame) => ({
      ...frame,
      crops: frame.crops.map((item) => (item.key === key ? decided : item)),
    })),
  };
}

export function removeSamples(session: PokerSession, keys: readonly string[]): PokerSession {
  const removed = new Set(keys);
  const pool = session.pool.filter((sample) => !removed.has(sample.key));
  return {
    ...session,
    pool,
    frames: session.frames.map((frame) => ({
      ...frame,
      crops: frame.crops.filter((sample) => !removed.has(sample.key)),
    })),
    currentIndex: Math.min(session.currentIndex, Math.max(0, pool.length - 1)),
  };
}

export function sessionReady(session: PokerSession): boolean {
  if (!session.pool.length || !pokerSessionSchema.safeParse(session).success) return false;
  const keys = new Set<string>();
  return session.pool.every((sample) => {
    if (keys.has(sample.key)) return false;
    keys.add(sample.key);
    if (sample.decision === "pending") return false;
    if (sample.decision === "label")
      return sample.label !== "" && validateLabel(sample.regionId, sample.label) === null;
    return sample.label === "";
  });
}
