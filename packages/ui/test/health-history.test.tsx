import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HealthHistory } from "../src/components/health-history.js";

const from = Date.UTC(2026, 9, 1);

describe("health history", () => {
  it("distinguishes unknown coverage from observed healthy, degraded, and failed days", () => {
    render(
      <HealthHistory
        days={[
          { from, to: from + 1, uptimePercent: null, coveragePercent: 0 },
          {
            from: from + 86_400_000,
            to: from + 86_400_001,
            uptimePercent: 100,
            coveragePercent: 100,
          },
          {
            from: from + 172_800_000,
            to: from + 172_800_001,
            uptimePercent: 99.5,
            coveragePercent: 90,
          },
          {
            from: from + 259_200_000,
            to: from + 259_200_001,
            uptimePercent: 0,
            coveragePercent: 100,
          },
          {
            from: from + 345_600_000,
            to: from + 345_600_001,
            uptimePercent: 100,
            coveragePercent: 0,
          },
        ]}
      />,
    );
    const bars = screen.getAllByRole("button");
    expect(bars[0]).toHaveAccessibleName(/No observations/);
    expect(bars[0]).toHaveClass("bg-muted-foreground/30");
    expect(bars[1]?.firstChild).toHaveClass("bg-emerald-500/70");
    expect(bars[2]?.firstChild).toHaveClass("bg-amber-500/80");
    expect(bars[2]?.firstChild).toHaveStyle({ height: "90%" });
    expect(bars[2]).toHaveAccessibleName(/90.00% observed/);
    expect(bars[3]?.firstChild).toHaveClass("bg-destructive/80");
    expect(bars[4]).toHaveClass("bg-muted-foreground/30");
    expect(bars[4]?.firstChild).toHaveStyle({ height: "0%" });
  });
});
