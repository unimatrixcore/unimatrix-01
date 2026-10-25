import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusDot } from "../src/components/ui/status-dot.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

describe("StatusDot", () => {
  it("names status and detail without adding a tab stop", () => {
    render(
      <TooltipProvider>
        <StatusDot tone="warn" label="Starting" detail="Waiting for a probe" />
      </TooltipProvider>,
    );
    const dot = screen.getByRole("img", { name: "Starting: Waiting for a probe" });
    expect(dot.tagName).toBe("SPAN");
    expect(dot).not.toHaveAttribute("tabindex");
    expect(dot).toHaveClass("bg-amber-500");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("shows its full description on hover and allows a consumer class", async () => {
    render(
      <TooltipProvider>
        <StatusDot tone="ok" label="Up" detail="Healthy" className="size-3" />
      </TooltipProvider>,
    );
    const dot = screen.getByRole("img", { name: "Up: Healthy" });
    expect(dot).toHaveClass("size-3");
    fireEvent.pointerMove(dot, { pointerType: "mouse" });
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Up: Healthy");
  });
  it("uses the label when detail is absent", () => {
    render(
      <TooltipProvider>
        <StatusDot tone="idle" label="Unknown" />
      </TooltipProvider>,
    );
    expect(screen.getByRole("img", { name: "Unknown" })).toHaveClass("bg-muted-foreground/60");
  });
});
