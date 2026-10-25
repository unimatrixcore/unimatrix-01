import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScrollArea } from "../src/components/ui/scroll-area.js";

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, options: PointerEventInit = {}) {
    super(type, options);
    this.pointerType = options.pointerType ?? "mouse";
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function elements() {
  const root = screen.getByTestId("area");
  return { root, viewport: root.querySelector('[data-slot="scroll-area-viewport"]')! };
}

describe("ScrollArea", () => {
  it("preserves the existing default viewport and hover controls", () => {
    render(<ScrollArea data-testid="area">content</ScrollArea>);
    const { root, viewport } = elements();
    expect(root).not.toHaveClass("ui-scroll-overlay");
    expect(root).not.toHaveAttribute("data-visible");
    expect(viewport).toHaveStyle({ overflowY: "scroll", overflowX: "hidden" });
    expect(viewport).toHaveTextContent("content");
  });

  it.each([
    ["vertical", "hidden", "scroll"],
    ["horizontal", "scroll", "hidden"],
    ["both", "scroll", "scroll"],
  ] as const)("enables exactly the requested %s axes", (orientation, overflowX, overflowY) => {
    render(
      <ScrollArea data-testid="area" orientation={orientation} variant="overlay">
        content
      </ScrollArea>,
    );
    expect(elements().viewport).toHaveStyle({ overflowX, overflowY });
  });

  it("merges viewport classes, attributes, object refs and caller handlers", () => {
    const ref = createRef<HTMLDivElement>();
    const handler = vi.fn();
    const { unmount } = render(
      <ScrollArea
        data-testid="area"
        variant="overlay"
        viewportProps={{
          ref,
          className: "rounded-none",
          "aria-label": "Records",
          tabIndex: 0,
          onScroll: handler,
        }}
      >
        content
      </ScrollArea>,
    );
    const { root, viewport } = elements();
    expect(ref.current).toBe(viewport);
    expect(viewport).toHaveClass("rounded-none");
    expect(viewport).not.toHaveClass("rounded-[inherit]");
    expect(viewport).toHaveAttribute("aria-label", "Records");
    fireEvent.scroll(viewport);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(root).toHaveAttribute("data-visible", "true");
    unmount();
    expect(ref.current).toBeNull();
  });

  it("honors callback ref cleanup and ordinary null callbacks", () => {
    const cleanup = vi.fn();
    const ref = vi.fn(() => cleanup);
    const { rerender, unmount } = render(<ScrollArea viewportProps={{ ref }}>content</ScrollArea>);
    expect(ref).toHaveBeenCalledWith(expect.any(HTMLDivElement));
    const next = vi.fn();
    rerender(<ScrollArea viewportProps={{ ref: next }}>content</ScrollArea>);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledTimes(1);
    unmount();
    expect(next).toHaveBeenLastCalledWith(null);
  });

  it("runs the caller first and lets cancellation suppress reveal", () => {
    render(
      <ScrollArea
        data-testid="area"
        variant="overlay"
        viewportProps={{
          onScroll: (event) => {
            event.preventDefault();
          },
        }}
        onPointerMove={(event) => {
          event.preventDefault();
        }}
      >
        content
      </ScrollArea>,
    );
    const { root, viewport } = elements();
    fireEvent.scroll(viewport);
    fireEvent.pointerMove(root, { clientX: 0, clientY: 0 });
    expect(root).toHaveAttribute("data-visible", "false");
  });

  it("ignores nested scrolling and touch proximity, then hides after 1500ms", () => {
    render(
      <ScrollArea data-testid="area" variant="overlay">
        <div data-testid="nested">nested</div>
      </ScrollArea>,
    );
    const { root, viewport } = elements();
    fireEvent.scroll(screen.getByTestId("nested"));
    fireEvent.pointerMove(root, { pointerType: "touch" });
    expect(root).toHaveAttribute("data-visible", "false");
    fireEvent.scroll(viewport);
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(root).toHaveAttribute("data-visible", "true");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(root).toHaveAttribute("data-visible", "false");
  });

  it("reveals within 40px and retains visibility while at the edge", () => {
    render(
      <ScrollArea data-testid="area" variant="overlay">
        content
      </ScrollArea>,
    );
    const { root } = elements();
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({ right: 200, bottom: 200 } as DOMRect);
    fireEvent.pointerMove(root, { clientX: 159, clientY: 50 });
    expect(root).toHaveAttribute("data-visible", "false");
    fireEvent.pointerMove(root, { clientX: 160, clientY: 50 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(root).toHaveAttribute("data-visible", "true");
    fireEvent.pointerLeave(root);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(root).toHaveAttribute("data-visible", "false");
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture"])(
    "clears press on %s despite caller cancellation",
    (eventName) => {
      render(
        <ScrollArea
          data-testid="area"
          variant="overlay"
          onPointerUpCapture={(event) => {
            event.preventDefault();
          }}
          onPointerCancelCapture={(event) => {
            event.preventDefault();
          }}
          onLostPointerCapture={(event) => {
            event.preventDefault();
          }}
        >
          <button data-slot="scroll-area-scrollbar" type="button">
            Track
          </button>
        </ScrollArea>,
      );
      const { root } = elements();
      fireEvent.pointerDown(screen.getByRole("button", { name: "Track" }));
      expect(root).toHaveAttribute("data-pressed", "true");
      fireEvent(root, new TestPointerEvent(eventName, { bubbles: true, cancelable: true }));
      expect(root).toHaveAttribute("data-pressed", "false");
    },
  );

  it("clears outside releases and pending reveal timers on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(
      <ScrollArea data-testid="area" variant="overlay">
        <button data-slot="scroll-area-scrollbar" type="button">
          Track
        </button>
      </ScrollArea>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Track" }));
    fireEvent.pointerUp(document.body);
    expect(elements().root).toHaveAttribute("data-pressed", "false");
    unmount();
    expect(remove).toHaveBeenCalledWith("pointerup", expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith("pointercancel", expect.any(Function), true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
