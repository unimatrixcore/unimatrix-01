import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { MarkdownEditor, type MarkdownEditorHandle } from "../src/editor.js";

function getEditorContent(): HTMLElement {
  return screen.getByRole("textbox", { name: "Post body" });
}

/**
 * Keyboard input is driven through the editor's imperative handle rather than
 * simulated keystrokes: CodeMirror's own input handling depends on
 * `beforeinput`, composition events, and layout measurements that jsdom does
 * not implement, so typed characters would prove nothing about the component.
 * What matters here — the document stays raw markdown, mode changes never
 * rewrite it — is fully observable this way. The Obsidian-style decorations
 * themselves are a real-browser check; jsdom reports no layout.
 */
describe("MarkdownEditor", () => {
  it(
    "mounts with the markdown it was given",
    // Cold mounting and accessibility assertions took 5.232s in CI's parallel test run.
    { timeout: 15_000 },
    () => {
      render(
        <MarkdownEditor label="Post body" onChange={vi.fn()} value={"# Title\n\nBody copy."} />,
      );

      const editor = getEditorContent();
      expect(editor).toHaveTextContent("# Title");
      expect(editor).toHaveTextContent("Body copy.");
    },
  );

  it("reports edits as raw markdown text", async () => {
    const onChange = vi.fn();
    const ref = React.createRef<MarkdownEditorHandle>();

    render(<MarkdownEditor label="Post body" onChange={onChange} ref={ref} value="" />);

    ref.current?.insertAtCursor("## Heading");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    // The reported value is the markdown source, character for character —
    // there is no serialization step that could normalize it.
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("## Heading");
  });

  it("mirrors an externally changed value into the document", () => {
    const { rerender } = render(
      <MarkdownEditor label="Post body" onChange={vi.fn()} value="first" />,
    );

    rerender(<MarkdownEditor label="Post body" onChange={vi.fn()} value="second" />);

    expect(getEditorContent()).toHaveTextContent("second");
    expect(getEditorContent()).not.toHaveTextContent("first");
  });

  it("switches between live and raw without changing the document", () => {
    const onChange = vi.fn();

    render(
      <MarkdownEditor label="Post body" onChange={onChange} value={"## Heading\n\nParagraph."} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Raw" }));
    expect(getEditorContent()).toHaveTextContent("## Heading");

    fireEvent.click(screen.getByRole("radio", { name: "Live" }));
    expect(getEditorContent()).toHaveTextContent("## Heading");

    // Mode changes must never edit the document.
    expect(onChange).not.toHaveBeenCalled();
  });

  // There is no read-only third mode: `live` already shows the post the way it
  // reads, and the site renders it for real one click away.
  it("offers only the two editable modes", () => {
    render(<MarkdownEditor label="Post body" onChange={vi.fn()} value="Body." />);

    expect(screen.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Live", "Raw"]);
  });

  // The control used to be gated on the box measuring as overflowing, which
  // made it a function of viewport height and font loading rather than of the
  // consumer's intent — in a tall container it never appeared at all.
  it("shows the expand control whenever the consumer asks for one", () => {
    render(<MarkdownEditor expandable label="Post body" onChange={vi.fn()} value="Body." />);

    expect(screen.getByRole("button", { name: "Expand the editor" })).toBeInTheDocument();
  });

  it("shows no expand control when the consumer does not ask for one", () => {
    render(<MarkdownEditor label="Post body" onChange={vi.fn()} value="Body." />);

    expect(screen.queryByRole("button", { name: /the editor/u })).not.toBeInTheDocument();
  });

  // The toolbar's job is to reach the document, not to own formatting: each
  // button dispatches into CodeMirror and the value comes back through
  // `onChange` like any other edit, so a consumer never has two sources for
  // the same text.
  it("applies a toolbar command to the document", async () => {
    const onChange = vi.fn();

    render(<MarkdownEditor label="Post body" onChange={onChange} value="" />);

    fireEvent.click(screen.getByRole("button", { name: "Bold" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(onChange.mock.calls.at(-1)?.[0]).toContain("**");
  });

  // Expanded, the editor stops scrolling internally and grows with the
  // document, so a height-locked consumer has to release that lock. It cannot
  // observe the change any other way — nothing above the editor is reachable
  // from inside it — which is what makes the callback load-bearing rather than
  // informational.
  it("toggles expansion and reports each change to the consumer", () => {
    const onExpandedChange = vi.fn();

    render(
      <MarkdownEditor
        expandable
        label="Post body"
        onChange={vi.fn()}
        onExpandedChange={onExpandedChange}
        value="Body."
      />,
    );

    const control = screen.getByRole("button", { name: "Expand the editor" });
    expect(control).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(control);

    expect(onExpandedChange).toHaveBeenCalledWith(true);
    const shrink = screen.getByRole("button", { name: "Shrink the editor" });
    expect(shrink).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(shrink);

    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Expand the editor" })).toBeInTheDocument();
  });

  it("reports mode changes to a controlled consumer without moving itself", () => {
    const onModeChange = vi.fn();

    render(
      <MarkdownEditor
        label="Post body"
        mode="live"
        onChange={vi.fn()}
        onModeChange={onModeChange}
        value="text"
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Raw" }));

    expect(onModeChange).toHaveBeenCalledWith("raw");
    expect(screen.getByRole("radio", { name: "Live" })).toHaveAttribute("aria-checked", "true");
  });

  it("inserts text at the cursor through its imperative handle", async () => {
    const onChange = vi.fn();
    const ref = React.createRef<MarkdownEditorHandle>();

    render(<MarkdownEditor label="Post body" onChange={onChange} ref={ref} value="intro " />);

    // This is how an uploaded image's markdown link reaches the body.
    ref.current?.insertAtCursor("![diagram](/api/content/assets/abc)");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("![diagram](/api/content/assets/abc)intro ");
    });
  });

  it("marks the surface non-editable when read-only", () => {
    render(<MarkdownEditor label="Post body" onChange={vi.fn()} readOnly value="fixed" />);

    expect(getEditorContent()).toHaveAttribute("contenteditable", "false");
  });
});
