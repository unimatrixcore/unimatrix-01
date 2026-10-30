import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DigestCard, type DigestCardProps } from "../src/components/ui/digest-card.js";
import { Card } from "../src/components/ui/card.js";

describe("Card height", () => {
  it("keeps omitted height identical to content height", () => {
    const { container } = render(
      <>
        <Card>Default</Card>
        <Card height="content">Content</Card>
      </>,
    );
    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards[0]!.className).toBe(cards[1]!.className);
    expect(cards[0]).not.toHaveAttribute("height");
  });
  it.each(["default", "sm"] as const)("allows height overrides for %s density", (size) => {
    const { container } = render(
      <>
        <Card height="summary" size={size} />
        <Card height="fill" size={size} />
        <Card height="summary" className="h-60 shrink" />
      </>,
    );
    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards[0]).toHaveClass("h-48", "shrink-0");
    expect(cards[1]).toHaveClass("min-h-0", "flex-1");
    expect(cards[1]).not.toHaveClass("min-h-56");
    expect(cards[2]).toHaveClass("h-60", "shrink");
    expect(cards[2]).not.toHaveClass("h-48", "shrink-0");
  });
});

describe("DigestCard", () => {
  it("composes structured slots with metadata pinned below and a single supplied action", () => {
    const { container } = render(
      <DigestCard
        icon={<svg />}
        label="Running"
        badge={<span>Ready</span>}
        action={<button type="button">Details</button>}
        primary="Healthy"
        supporting="All checks passed"
        meta="Checked now"
      />,
    );
    const card = container.querySelector('[data-slot="card"]')!;
    expect(card).toHaveAttribute("data-size", "sm");
    expect(card).toHaveClass("h-48");
    expect(screen.getByText("Checked now")).toHaveClass("mt-auto");
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("All checks passed")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(card).not.toHaveAttribute("tabindex");
  });
  it("supports a custom centered warning and bottom details", () => {
    render(
      <DigestCard icon={<svg />} label="Health" height="fill" size="default">
        <div className="flex flex-1 items-center justify-center">Awaiting probe</div>
        <button type="button">Container details</button>
        <p>Last checked today</p>
      </DigestCard>,
    );
    expect(screen.getByText("Awaiting probe")).toHaveClass("flex-1", "items-center");
    expect(screen.getByRole("button", { name: "Container details" })).toBeInTheDocument();
    expect(screen.getByText("Last checked today")).toBeInTheDocument();
  });
  it("rejects mixed structured and custom body contracts", () => {
    // @ts-expect-error Structured slots and custom children are mutually exclusive.
    const invalid: DigestCardProps = {
      icon: null,
      label: "Health",
      primary: "Up",
      children: "Custom",
    };
    expect(invalid.label).toBe("Health");
  });
});
