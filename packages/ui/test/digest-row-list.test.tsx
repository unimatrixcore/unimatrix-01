import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Card, CardContent } from "../src/components/ui/card.js";
import { DigestRow, DigestRowList } from "../src/components/ui/digest-row-list.js";

describe("DigestRowList", () => {
  it.each(["default", "sm"] as const)("aligns edge bleed with %s Card section spacing", (size) => {
    const clicked = vi.fn();
    render(
      <Card size={size}>
        <CardContent>
          <DigestRowList aria-label="Recent activity">
            <DigestRow
              indicator={<span aria-label="Healthy" role="img" />}
              itemKey="abc123"
              description="A long complete description remains available"
              state="Complete"
              meta="2m ago"
              action={
                <button type="button" onClick={clicked}>
                  View output
                </button>
              }
            />
          </DigestRowList>
        </CardContent>
      </Card>,
    );
    const list = screen.getByRole("list", { name: "Recent activity" });
    const row = within(list).getByRole("listitem");
    expect(list.tagName).toBe("UL");
    expect(row.tagName).toBe("LI");
    expect(list).toHaveClass("-mx-[var(--card-section-padding,--spacing(6))]");
    expect(row).toHaveClass("px-[var(--card-section-padding,--spacing(6))]");
    expect(screen.getByText("abc123")).toHaveClass("font-mono");
    expect(screen.getByTitle("A long complete description remains available")).toHaveClass(
      "truncate",
    );
    const action = within(row).getByRole("button", { name: "View output" });
    expect(row).not.toHaveAttribute("tabindex");
    expect(row.querySelectorAll('button, a[href], [tabindex="0"]')).toHaveLength(1);
    action.focus();
    expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(clicked).toHaveBeenCalledTimes(1);
  });
  it("keeps rows noninteractive when no action is supplied", () => {
    render(
      <DigestRowList>
        <DigestRow itemKey="def456" description="Recorded activity" className="py-4" />
      </DigestRowList>,
    );
    expect(screen.getByRole("listitem")).toHaveClass("py-4");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Recorded activity")).toBeInTheDocument();
  });
});
