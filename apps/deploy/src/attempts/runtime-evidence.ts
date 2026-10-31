import { open } from "node:fs/promises";
import { z } from "zod";
import { deployRuntimeEvidenceSchema, type DeployAttemptRuntimeEvidence } from "@unimatrix/shared";

export const RUNTIME_EVIDENCE_MAX_BYTES = 1_048_576;
export const RUNTIME_EVIDENCE_MAX_AGE_MS = 30_000;

export const runtimeEvidenceSnapshotSchema = z.strictObject({
  observedAt: z.number().int().nonnegative(),
  evidence: z.array(deployRuntimeEvidenceSchema).max(64),
});

export function createRuntimeEvidenceReader(path: string, now: () => number = Date.now) {
  return async (): Promise<DeployAttemptRuntimeEvidence[]> => {
    try {
      const file = await open(path, "r");
      let buffer: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > RUNTIME_EVIDENCE_MAX_BYTES) return [];
        buffer = Buffer.alloc(RUNTIME_EVIDENCE_MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > RUNTIME_EVIDENCE_MAX_BYTES) return [];
        buffer = buffer.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      const snapshot = runtimeEvidenceSnapshotSchema.parse(JSON.parse(buffer.toString("utf8")));
      const checkedAt = now();
      if (
        snapshot.observedAt > checkedAt ||
        checkedAt - snapshot.observedAt > RUNTIME_EVIDENCE_MAX_AGE_MS
      )
        return [];
      if (snapshot.evidence.some((entry) => entry.observedAt !== snapshot.observedAt)) return [];
      if (
        new Set(snapshot.evidence.map((entry) => entry.containerId)).size !==
        snapshot.evidence.length
      )
        return [];
      const counts = new Map<string, number>();
      for (const entry of snapshot.evidence)
        counts.set(entry.app, (counts.get(entry.app) ?? 0) + 1);
      return snapshot.evidence.filter((entry) => counts.get(entry.app) === 1);
    } catch {
      return [];
    }
  };
}
