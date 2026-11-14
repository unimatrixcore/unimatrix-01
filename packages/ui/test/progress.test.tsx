import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Progress } from "../src/components/ui/progress.js";

it("exposes measured values to assistive technology and preserves indeterminate progress", () => {
  const view = render(<Progress aria-label="Epoch progress" value={25} />);
  const progress = screen.getByRole("progressbar", { name: "Epoch progress" });
  expect(progress).toHaveAttribute("aria-valuenow", "25");
  expect(progress).toHaveAttribute("aria-valuemax", "100");
  expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({
    transform: "translateX(-75%)",
  });
  view.rerender(<Progress aria-label="Epoch progress" value={null} />);
  expect(progress).not.toHaveAttribute("aria-valuenow");
  expect(progress).toHaveAttribute("data-state", "indeterminate");
});
