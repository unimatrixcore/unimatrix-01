import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DigestCardGrid } from "../src/components/ui/digest-card-grid.js";
import { Card } from "../src/components/ui/card.js";

describe("DigestCardGrid", () => {
  it("preserves caller children and separates the filling full-width card", () => {
    const { container } = render(
      <DigestCardGrid spanning={<Card height="fill">History</Card>}>
        <Card height="summary">First</Card>
        <Card height="summary">Second</Card>
      </DigestCardGrid>,
    );
    const summaries = screen.getByText("First").parentElement!;
    const spanning = screen.getByText("History").parentElement!;
    expect(summaries).toHaveClass("grid-cols-1", "sm:grid-cols-2", "shrink-0");
    expect(summaries.children).toHaveLength(2);
    expect(spanning).toHaveClass("min-h-56", "flex-1");
    expect(spanning.parentElement).toBe(summaries.parentElement);
    expect(screen.getByText("History")).toHaveClass("min-h-0", "flex-1");
    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(3);
  });
  it("accepts arbitrary children without manufacturing a spanning wrapper", () => {
    const { container } = render(
      <DigestCardGrid className="gap-6">
        <p>Empty summary</p>
      </DigestCardGrid>,
    );
    expect(container.firstElementChild).toHaveClass("gap-6");
    expect(container.firstElementChild!.children).toHaveLength(1);
    expect(screen.getByText("Empty summary")).toBeInTheDocument();
  });
});
