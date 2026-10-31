import type { PublicDeploymentStatusResponse } from "@unimatrix/shared";

export type StatusScenario = "operational" | "degraded" | "outage" | "unavailable" | "empty";

export function getMockPublicStatus(scenario: StatusScenario): PublicDeploymentStatusResponse {
  const lastCheckedAt = Math.floor(Date.now() / 60_000) * 60_000;
  if (scenario === "empty") return { apps: [] };
  return {
    apps: [
      { displayName: "Unimatrix", state: "up", lastCheckedAt },
      { displayName: "API", state: scenario === "outage" ? "down" : "up", lastCheckedAt },
      {
        displayName: "CFLOP",
        state: scenario === "degraded" ? "degraded" : "up",
        lastCheckedAt: scenario === "degraded" ? null : lastCheckedAt,
      },
    ].map((app, index) => {
      const history = getMockPublicHistory(index).map((day) => ({
        from: Date.parse(day.day),
        to: Date.parse(day.day) + 86_400_000,
        uptimePercent: day.uptime * 100,
        coveragePercent: 100,
      }));
      return {
        ...app,
        state: app.state as "up" | "down" | "degraded",
        history,
        summary: {
          uptimePercent: history.reduce((sum, day) => sum + day.uptimePercent, 0) / history.length,
          coveragePercent: 100,
        },
      };
    }),
  };
}

export function getMockPublicHistory(serviceIndex: number) {
  return Array.from({ length: 30 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
    uptime: index === 9 + serviceIndex ? 0.982 : index === 4 ? 0.9994 : 1,
  }));
}
