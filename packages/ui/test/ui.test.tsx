import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, Card, CardContent, CardFooter, CardHeader, CardTitle, cn } from "../src/index.js";

describe("@unimatrix/ui baseline", () => {
  it("merges class names predictably", () => {
    expect(cn("px-2 text-sm", "px-4", undefined, false, "font-medium")).toBe(
      "text-sm px-4 font-medium",
    );
  });

  it("renders a representative shared primitive in jsdom", () => {
    render(<Badge variant="secondary">Ops console</Badge>);

    expect(screen.getByText("Ops console")).toHaveAttribute("data-slot", "badge");
  });
});

describe("Card consumer overrides", () => {
  it.each(["default", "sm"] as const)("lets consumers override %s size defaults", (size) => {
    const { container } = render(
      <Card size={size} className="py-0 gap-0">
        <CardHeader className="border-b px-0 pb-0">
          <CardTitle className="text-lg">Deployment</CardTitle>
        </CardHeader>
        <CardContent className="px-0">Output</CardContent>
        <CardFooter className="border-t px-0 pt-0">Actions</CardFooter>
      </Card>,
    );
    const card = container.querySelector('[data-slot="card"]')!;
    expect(card).toHaveAttribute("data-size", size);
    expect(card).toHaveClass("py-0", "gap-0");
    expect(card.className).not.toMatch(/(?:^|\s)(?:\S+:)?(?:py|gap)-(?:4|6)(?:\s|$)/);
    for (const slot of ["card-header", "card-content", "card-footer"]) {
      const section = container.querySelector(`[data-slot="${slot}"]`)!;
      expect(section).toHaveClass("px-0");
      expect(section.className).not.toMatch(/(?:^|\s)(?:\S+:)?px-(?!0(?:\s|$))\S+/);
    }
    const title = container.querySelector('[data-slot="card-title"]')!;
    expect(title).toHaveClass("text-lg");
    expect(title.className).not.toMatch(/(?:^|\s)(?:\S+:)?text-(?:sm|base|\[length:[^ ]+)(?:\s|$)/);
    expect(container.querySelector('[data-slot="card-header"]')).toHaveClass("pb-0");
    expect(container.querySelector('[data-slot="card-footer"]')).toHaveClass("pt-0");
  });

  it("keeps responsive consumer spacing alongside its base override", () => {
    const { container } = render(
      <Card size="sm" className="py-0 md:py-8">
        <CardContent className="px-0 md:px-8">Output</CardContent>
      </Card>,
    );
    expect(container.querySelector('[data-slot="card"]')).toHaveClass("py-0", "md:py-8");
    expect(container.querySelector('[data-slot="card-content"]')).toHaveClass("px-0", "md:px-8");
  });
});
