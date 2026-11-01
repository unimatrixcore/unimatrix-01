import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolMasterDetail } from "../src/tool.js";

describe("ToolMasterDetail", () => {
  it("frames both panes as cards while preserving independent scrolling", () => {
    render(
      <ToolMasterDetail
        variant="cards"
        detailScroll="managed"
        listHeader={<h1>Deploys</h1>}
        list={<button>Service</button>}
        detail={<div data-testid="service-detail">Detail</div>}
      />,
    );
    expect(screen.getByRole("heading").closest('[data-slot="card"]')).not.toBeNull();
    expect(screen.getByRole("button").closest('[data-slot="scroll-area"]')).not.toBeNull();
    const detail = screen.getByTestId("service-detail");
    expect(detail.closest('[data-slot="card"]')).not.toBeNull();
    expect(detail.closest('[data-slot="scroll-area"]')).toBeNull();
  });
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
