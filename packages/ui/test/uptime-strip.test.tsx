import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UptimeStrip } from "../src/components/ui/uptime-strip.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

describe("UptimeStrip", () => {
  it("preserves caller ordering and equal-height bars with shared threshold tones", () => {
    render(
      <TooltipProvider>
        <UptimeStrip
          label="Recent availability"
          samples={[
            { key: "c", label: "Today", uptime: 0.999 },
            { key: "a", label: "Yesterday", uptime: 0.99 },
            { key: "b", label: "Earlier", uptime: 0.989 },
            { key: "d", label: "Missing" },
            { key: "e", label: "Invalid", uptime: NaN },
          ]}
        />
      </TooltipProvider>,
    );
    const strip = screen.getByRole("group", { name: "Recent availability" });
    const bars = within(strip).getAllByRole("img");
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual([
      "Today: 99.90% uptime",
      "Yesterday: 99.00% uptime",
      "Earlier: 98.90% uptime",
      "Missing: No reading",
      "Invalid: No reading",
    ]);
    expect(bars[0]).toHaveClass("bg-emerald-500", "opacity-70");
    expect(bars[1]).toHaveClass("bg-amber-500", "opacity-80");
    expect(bars[2]).toHaveClass("bg-destructive", "opacity-80");
    for (const bar of bars) {
      expect(bar).toHaveClass("h-7", "flex-1");
      expect(bar).not.toHaveAttribute("tabindex");
    }
    expect(bars[3]).toHaveClass("bg-muted-foreground/60");
    expect(bars[4]).toHaveClass("bg-muted-foreground/60");
    expect(bars[3]).not.toHaveClass("opacity-70", "opacity-80");
    expect(bars[4]).not.toHaveClass("opacity-70", "opacity-80");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("reveals accessible sample detail without extra controls", async () => {
    render(
      <TooltipProvider>
        <UptimeStrip label="Availability" samples={[{ key: "now", label: "Now", uptime: null }]} />
      </TooltipProvider>,
    );
    fireEvent.pointerMove(screen.getByRole("img", { name: "Now: No reading" }), {
      pointerType: "mouse",
    });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Now: No reading");
  });
  it("accepts empty samples and consumer spacing", () => {
    render(<UptimeStrip label="Not recorded" samples={[]} className="gap-1" />);
    expect(screen.getByRole("group", { name: "Not recorded" })).toHaveClass("gap-1");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
