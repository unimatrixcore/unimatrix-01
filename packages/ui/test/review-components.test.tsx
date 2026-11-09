import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewSessionStatus, ReviewSuggestion } from "../src/public.js";

const ids = {
  root: "model-review",
  rawText: "model-raw",
  suggestedText: "model-text",
  status: "model-state",
  use: "model-use",
  accept: "model-accept",
  retry: "model-retry",
};

describe("ReviewSuggestion", () => {
  it("preserves both identical fields, IDs, shortcuts and action callbacks", () => {
    const onUse = vi.fn();
    const onAccept = vi.fn();
    const onRetry = vi.fn();
    render(
      <ReviewSuggestion
        rawText="Same"
        suggestedText="Same"
        state="ready"
        statusText="Ready"
        canAccept
        ids={ids}
        onUse={onUse}
        onAccept={onAccept}
        onRetry={onRetry}
      />,
    );
    expect(screen.getAllByText("Same")).toHaveLength(2);
    expect(document.getElementById(ids.rawText)).toHaveTextContent("Same");
    expect(document.getElementById(ids.suggestedText)).toHaveTextContent("Same");
    expect(screen.getByRole("status")).toHaveAttribute("id", ids.status);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion Ctrl+Space" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept Ctrl+Enter" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(document.getElementById(ids.root)).toHaveAttribute("data-state", "ready");
  });

  it("distinguishes explicit blank from missing text and permits using blank", () => {
    const { rerender } = render(
      <ReviewSuggestion
        rawText={null}
        suggestedText=""
        state="ready"
        statusText="Blank result"
        ids={ids}
      />,
    );
    expect(document.getElementById(ids.rawText)).toHaveTextContent("Not available");
    expect(document.getElementById(ids.suggestedText)).toHaveTextContent("Blank");
    expect(screen.getByRole("button", { name: /Use suggestion/ })).toBeEnabled();
    rerender(
      <ReviewSuggestion
        rawText=""
        suggestedText={null}
        state="empty"
        statusText="No result"
        ids={ids}
      />,
    );
    expect(document.getElementById(ids.rawText)).toHaveTextContent("Blank");
    expect(screen.getByRole("button", { name: /Use suggestion/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Accept/ })).toBeDisabled();
  });

  it("disables loading and busy actions without firing callbacks", () => {
    const action = vi.fn();
    const { rerender } = render(
      <ReviewSuggestion
        rawText="Raw"
        suggestedText="Suggestion"
        state="loading"
        statusText="Loading"
        ids={ids}
        onUse={action}
        onAccept={action}
        onRetry={action}
      />,
    );
    expect(screen.getByRole("region", { name: "Review suggestion" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(action).not.toHaveBeenCalled();
    rerender(
      <ReviewSuggestion
        rawText="Raw"
        suggestedText="Suggestion"
        state="ready"
        statusText="Saving"
        busy
        canAccept
        onUse={action}
        onAccept={action}
        onRetry={action}
      />,
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it("allows independent acceptance and retry after a suggestion error", () => {
    render(
      <ReviewSuggestion
        rawText="Raw"
        suggestedText={null}
        state="error"
        statusText="Unavailable"
        canAccept
        shortcutLabels={{ use: "Alt+U", accept: "Alt+A" }}
        actionLabels={{ use: "Use and edit", accept: "Accept and advance", retry: "Try again" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Use and edit Alt+U" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Accept and advance Alt+A" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("keeps stable native controls usable by a legacy DOM owner", () => {
    render(
      <ReviewSuggestion
        rawText={null}
        suggestedText={null}
        state="empty"
        statusText="Waiting"
        ids={ids}
      />,
    );
    const button = document.getElementById(ids.use) as HTMLButtonElement;
    const clicked = vi.fn();
    button.onclick = clicked;
    button.disabled = false;
    document.getElementById(ids.suggestedText)!.textContent = "Updated externally";
    fireEvent.click(button);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(document.getElementById(ids.suggestedText)).toHaveTextContent("Updated externally");
  });
});

describe("ReviewSessionStatus", () => {
  it("shows elapsed time and editing pause without a penalty", () => {
    render(
      <ReviewSessionStatus
        points={120}
        streak={3}
        elapsedMs={125999}
        clockState="editing"
        ids={{ score: "score-display", timer: "timer-display", streak: "combo-multiplier" }}
      />,
    );
    expect(document.getElementById("score-display")).toHaveTextContent("120 points");
    expect(document.getElementById("combo-multiplier")).toHaveTextContent("3 streak");
    expect(document.getElementById("timer-display")).toHaveTextContent("2:05");
    expect(screen.getByText("Editing · clock paused · no time penalty")).toBeInTheDocument();
  });

  it("allows legacy updates to replace each complete status field", () => {
    render(
      <ReviewSessionStatus
        points={0}
        streak={0}
        elapsedMs={0}
        clockState="reading"
        ids={{ score: "score-display", timer: "timer-display", streak: "combo-multiplier" }}
      />,
    );
    document.getElementById("score-display")!.textContent = "12 points";
    document.getElementById("timer-display")!.textContent = "Editing · clock paused";
    document.getElementById("combo-multiplier")!.textContent = "4 streak";
    expect(screen.getByLabelText("Review session").textContent).toBe(
      "12 points4 streakEditing · clock paused",
    );
  });

  it.each([NaN, Infinity, -Infinity, -10])(
    "normalizes invalid or negative values (%s)",
    (value) => {
      const { container } = render(
        <ReviewSessionStatus points={value} streak={value} elapsedMs={value} clockState="paused" />,
      );
      expect(container).toHaveTextContent("0 points");
      expect(container).toHaveTextContent("0 streak");
      expect(container).toHaveTextContent("0:00");
      expect(screen.getByText("Paused")).toBeInTheDocument();
    },
  );

  it.each([
    ["reading", "Reading"],
    ["loading", "Loading · clock paused"],
  ] as const)("labels %s time", (clockState, label) => {
    render(
      <ReviewSessionStatus points={1.9} streak={2.8} elapsedMs={999} clockState={clockState} />,
    );
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });
});

it("supports generic session labels independently of review naming", async () => {
  const { GamificationStatus } = await import("../src/public.js");
  render(
    <GamificationStatus
      points={4}
      streak={2}
      elapsedMs={1000}
      clockState="reading"
      ariaLabel="Practice progress"
      labels={{ points: "credits", streak: "completed", reading: "Studying" }}
    />,
  );
  expect(screen.getByLabelText("Practice progress")).toHaveTextContent("4 credits");
  expect(screen.getByLabelText("Practice progress")).toHaveTextContent("2 completed");
  expect(screen.getByText("Studying")).toBeInTheDocument();
});
