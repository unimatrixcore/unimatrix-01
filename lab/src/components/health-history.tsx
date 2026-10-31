import { HealthHistory as SharedHealthHistory } from "@unimatrix/ui/public";

export interface HealthHistoryDay {
  day: string;
  uptime: number;
}

export function HealthHistory({ daily }: { daily: readonly HealthHistoryDay[] }) {
  return (
    <SharedHealthHistory
      days={daily.map((day) => ({
        from: Date.parse(day.day),
        to: Date.parse(day.day) + 86_400_000,
        uptimePercent: day.uptime * 100,
        coveragePercent: 100,
      }))}
    />
  );
}
