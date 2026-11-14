import { expect, it } from "vitest";
import { pokerWorkspaceStateSchema } from "../src/index.js";

it("accepts bounded internal places and preserves independent workspace positions", () => {
  const place = {
    path: "/gameplay",
    ocrPath: "/labeling/244",
    scroll: { gameplay: { top: 500, left: 0 }, training: { top: 200, left: 0 } },
    gameplay: { sessionId: "recording", view: "frames", hand: "42" },
    trainingRun: "version-5",
  };
  expect(pokerWorkspaceStateSchema.parse(place)).toEqual(place);
});

it("bounds independent training pane offsets without accepting oversized stored state", () => {
  const trainingPanes = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `version-${index}`,
      { top: index * 100, left: index },
    ]),
  );
  expect(pokerWorkspaceStateSchema.parse({ trainingPanes })).toEqual({ trainingPanes });
  for (const value of [
    { ...trainingPanes, extra: { top: 0, left: 0 } },
    { "": { top: 0, left: 0 } },
    { ["x".repeat(129)]: { top: 0, left: 0 } },
    { versions: { top: -1, left: 0 } },
  ])
    expect(pokerWorkspaceStateSchema.safeParse({ trainingPanes: value }).success).toBe(false);
});

it("rejects external routes, malformed positions and oversized identities while dropping secret fields", () => {
  for (const value of [
    { path: "https://example.test" },
    { path: "/api/training" },
    { path: "/labeling/-1" },
    { scroll: { gameplay: { top: Infinity, left: 0 } } },
    { scroll: { training: { top: -1, left: 0 } } },
    { gameplay: { sessionId: "s", view: "unknown" } },
    { trainingRun: "x".repeat(129) },
  ])
    expect(pokerWorkspaceStateSchema.safeParse(value).success).toBe(false);
  expect(
    pokerWorkspaceStateSchema.parse({ path: "/training", api_key: "not-a-preference" }),
  ).toEqual({ path: "/training" });
});
