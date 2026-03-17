import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge, cn } from "../src/index.js";

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
