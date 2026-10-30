import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolMasterDetail } from "../src/tool.js";

describe("ToolMasterDetail", () => {
  it("keeps the list header outside both pane viewports", () => {
    render(
      <ToolMasterDetail
        listHeader={<h1>Records</h1>}
        list={<button type="button">Select record</button>}
        detail={<button type="button">Open output</button>}
      />,
    );
    expect(screen.getByRole("heading").closest('[data-slot="scroll-area"]')).toBeNull();
    const listArea = screen
      .getByRole("button", { name: "Select record" })
      .closest('[data-slot="scroll-area"]');
    const detailArea = screen
      .getByRole("button", { name: "Open output" })
      .closest('[data-slot="scroll-area"]');
    expect(listArea).toHaveAttribute("data-variant", "overlay");
    expect(detailArea).toHaveAttribute("data-variant", "overlay");
    expect(detailArea).not.toBe(listArea);
  });

  it("lets a managed composition own detail scrolling without an outer scroller", () => {
    const { container } = render(
      <ToolMasterDetail
        className="gap-2"
        detailScroll="managed"
        listHeader="Records"
        list="list"
        detail={<div data-testid="detail">managed detail</div>}
      />,
    );
    const detail = screen.getByTestId("detail");
    expect(detail.closest('[data-slot="scroll-area"]')).toBeNull();
    expect(detail.parentElement).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-col",
      "overflow-hidden",
    );
    expect(container.firstElementChild).toHaveClass("gap-2");
    expect(container.firstElementChild).not.toHaveClass("gap-4");
  });
});
