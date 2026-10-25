import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  RiBold,
  RiCodeSSlashLine,
  RiCollapseDiagonalLine,
  RiDoubleQuotesL,
  RiExpandDiagonalLine,
  RiH1,
  RiItalic,
  RiLinkM,
  RiListUnordered,
} from "@remixicon/react";
import * as React from "react";

import { cn } from "../../lib/utils.js";
import { Card, CardHeader } from "../ui/card.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { ActionTooltip } from "../ui/action-tooltip.js";
import { Button } from "../ui/button.js";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.js";
import { markdownLivePreview, markdownLivePreviewTheme } from "./live-preview.js";
import {
  insertLink,
  toggleInlineMarker,
  toggleLinePrefix,
  type MarkdownEdit,
} from "./markdown-commands.js";

/**
 * - `live`: markdown text with rendered styling and syntax hidden off-cursor.
 * - `raw`: the same text with the decorations detached.
 *
 * There is no read-only preview mode. `live` already shows the post the way it
 * reads, and the site renders it for real one click away; a third mode that
 * could not be typed into was a tab to leave and come back from rather than a
 * way of working.
 */
export const MARKDOWN_EDITOR_MODES = ["live", "raw"] as const;

export type MarkdownEditorMode = (typeof MARKDOWN_EDITOR_MODES)[number];

const MODE_LABELS: Record<MarkdownEditorMode, string> = {
  live: "Live",
  raw: "Raw",
};

/**
 * Toolbar buttons, in render order. Each is a pure edit over
 * `(document, selection)` so the toolbar's behaviour is testable without an
 * `EditorView` — see `./markdown-commands`.
 *
 * Deliberately short. This is a markdown editor: anything not on this list is
 * still one or two keystrokes away in the document itself, and a toolbar that
 * grows past a single row starts competing with the text for attention.
 */
const TOOLBAR_ACTIONS: {
  key: string;
  label: string;
  icon: typeof RiBold;
  apply: (doc: string, from: number, to: number) => MarkdownEdit;
}[] = [
  {
    key: "bold",
    label: "Bold",
    icon: RiBold,
    apply: (doc, from, to) => toggleInlineMarker(doc, from, to, "**"),
  },
  {
    key: "italic",
    label: "Italic",
    icon: RiItalic,
    apply: (doc, from, to) => toggleInlineMarker(doc, from, to, "*"),
  },
  {
    key: "code",
    label: "Inline code",
    icon: RiCodeSSlashLine,
    apply: (doc, from, to) => toggleInlineMarker(doc, from, to, "`"),
  },
  { key: "link", label: "Link", icon: RiLinkM, apply: insertLink },
  {
    key: "heading",
    label: "Heading",
    icon: RiH1,
    apply: (doc, from, to) => toggleLinePrefix(doc, from, to, "## "),
  },
  {
    key: "list",
    label: "Bullet list",
    icon: RiListUnordered,
    apply: (doc, from, to) => toggleLinePrefix(doc, from, to, "- "),
  },
  {
    key: "quote",
    label: "Quote",
    icon: RiDoubleQuotesL,
    apply: (doc, from, to) => toggleLinePrefix(doc, from, to, "> "),
  },
];

export interface MarkdownEditorHandle {
  /**
   * Replaces the current selection with `text` and focuses the editor. Used
   * for inserting an uploaded image's markdown at the caret.
   */
  insertAtCursor: (text: string) => void;
  focus: () => void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Controlled mode. Omit to let the editor own it. */
  mode?: MarkdownEditorMode;
  defaultMode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  /** Accessible name for the editing surface. Never painted — see the render. */
  label: string;
  /**
   * Rendered at the start of the toolbar row, left of the formatting buttons.
   * The consumer's own visible field label goes here, which is what puts it
   * directly above the editing surface.
   */
  header?: React.ReactNode;
  /**
   * Rendered at the end of the toolbar row, after the formatting buttons.
   * Consumer-specific actions belong here — `apps/web` puts "Insert image"
   * there, which this package cannot own because uploading is an authenticated
   * app concern.
   */
  actions?: React.ReactNode;
  placeholder?: string;
  className?: string;
  editorClassName?: string;
  readOnly?: boolean;
  /**
   * Show a control that grows the editing surface to the whole document
   * instead of scrolling inside its box.
   *
   * The control is unconditional once this is set. It was previously gated on
   * the collapsed box measuring as overflowing, on the reasoning that an
   * answer to a scrollbar is pointless without one — but the gate made the
   * affordance appear and disappear with the viewport, the font load and the
   * height of the fields above the editor, so in a tall enough container it
   * was simply never offered.
   */
  expandable?: boolean;
  /**
   * Called when the expand control is used. Expanded, the editor stops
   * scrolling internally and grows with the document, so a consumer whose
   * layout is height-locked has to release that lock here — nothing above the
   * editor can be reached from inside it.
   */
  onExpandedChange?: (expanded: boolean) => void;
}

const editableCompartment = new Compartment();
const livePreviewCompartment = new Compartment();

const baseTheme = EditorView.theme({
  "&": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.875rem",
    backgroundColor: "transparent",
    color: "var(--foreground)",
    // Fill the host rather than the document. Paired with the `flex-1` host
    // element, this is what makes the whole visible box clickable: without it
    // CodeMirror ends at the last line and every click below that lands on a
    // plain `div` that cannot take focus.
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-content": {
    padding: "0.75rem",
    caretColor: "var(--foreground)",
    // `.cm-content` is the element that actually takes the click, so it has to
    // grow too — `.cm-editor` filling the box is not enough on its own. The
    // 16rem is the editor's floor, and it lives here rather than on the box:
    // on the box it was a hard minimum that overflowed a height-constrained
    // column and painted over whatever sat under it, while here a short box
    // simply scrolls, which is what the scrollbar and the expand control are
    // for.
    minHeight: "max(100%, 16rem)",
  },
  ".cm-line": { padding: "0 0.25rem" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--primary) 28%, transparent)",
  },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
});

function buildExtensions(options: {
  label: string;
  placeholder: string | undefined;
  readOnly: boolean;
  livePreview: boolean;
  onChange: (value: string) => void;
}): Extension[] {
  return [
    history(),
    // Without this the caret and the selection are the browser's own, drawn
    // against whatever DOM CodeMirror happens to have emitted — so on a line
    // holding only the placeholder widget they land on the zero-width buffer
    // element inserted before it, and where that sits differs by engine:
    // correct in Chrome, a caret riding above the placeholder in Firefox.
    // `drawSelection` replaces both with elements CodeMirror positions from
    // its own coordinates, which is also what the `.cm-cursor`,
    // `.cm-dropCursor` and `.cm-selectionBackground` rules in `baseTheme`
    // have always been written against — they matched nothing until now.
    drawSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    baseTheme,
    markdownLivePreviewTheme,
    EditorView.contentAttributes.of({ "aria-label": options.label, role: "textbox" }),
    ...(options.placeholder === undefined ? [] : [placeholderExtension(options.placeholder)]),
    livePreviewCompartment.of(options.livePreview ? markdownLivePreview : []),
    editableCompartment.of(EditorView.editable.of(!options.readOnly)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        options.onChange(update.state.doc.toString());
      }
    }),
  ];
}

/**
 * Markdown editor with an Obsidian-style live preview.
 *
 * The document is always the raw markdown text — switching modes attaches or
 * detaches decorations, and never rewrites the document. There is no
 * HTML-to-markdown serialization step, so opening and saving a post cannot
 * reformat it.
 *
 * Lives behind `@unimatrix/ui/editor` rather than `./public` so CodeMirror
 * stays out of the public site's dependency graph entirely.
 */
export const MarkdownEditor = React.forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      actions,
      className,
      defaultMode = "live",
      editorClassName,
      expandable = false,
      header,
      label,
      mode: controlledMode,
      onChange,
      onExpandedChange,
      onModeChange,
      placeholder,
      readOnly = false,
      value,
    },
    ref,
  ) {
    const hostRef = React.useRef<HTMLDivElement | null>(null);
    const viewRef = React.useRef<EditorView | null>(null);
    const onChangeRef = React.useRef(onChange);
    const [uncontrolledMode, setUncontrolledMode] = React.useState<MarkdownEditorMode>(defaultMode);
    const mode = controlledMode ?? uncontrolledMode;
    const [expanded, setExpanded] = React.useState(false);
    const boxRef = React.useRef<HTMLDivElement | null>(null);
    // The height the box had when it was expanded, held as its floor for as
    // long as it stays expanded. Expanding hands CodeMirror's own height to
    // the document, so a short draft would otherwise make "expand" visibly
    // shrink the writing surface — the opposite of what the control says it
    // does. Captured rather than declared: the collapsed box takes whatever
    // the consumer's layout leaves it, so there is no static value to use.
    const [expandedMinHeight, setExpandedMinHeight] = React.useState<number | null>(null);

    // The updateListener is installed once, so it must not close over a stale
    // callback when the consumer re-renders with a new one.
    onChangeRef.current = onChange;

    React.useEffect(() => {
      const host = hostRef.current;

      if (host === null) {
        return;
      }

      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: value,
          extensions: buildExtensions({
            label,
            placeholder,
            readOnly,
            livePreview: true,
            onChange: (next) => {
              onChangeRef.current(next);
            },
          }),
        }),
      });

      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Built once, deliberately: subsequent prop changes are applied through
      // compartments and transactions below, so the document, its undo
      // history, and the cursor all survive a re-render. `value`, `label`,
      // `placeholder`, and `readOnly` are read here only to seed the initial
      // state, which is why they are absent from the dependency list.
    }, []);

    // Mirrors an externally changed `value` into the document, without
    // clobbering what the user is typing (the two are equal in that case).
    React.useEffect(() => {
      const view = viewRef.current;

      if (view === null || view.state.doc.toString() === value) {
        return;
      }

      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }, [value]);

    React.useEffect(() => {
      viewRef.current?.dispatch({
        effects: livePreviewCompartment.reconfigure(mode === "live" ? markdownLivePreview : []),
      });
    }, [mode]);

    React.useEffect(() => {
      viewRef.current?.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
      });
    }, [readOnly]);

    React.useImperativeHandle(
      ref,
      () => ({
        insertAtCursor: (text: string) => {
          const view = viewRef.current;

          if (view === null) {
            return;
          }

          const { from, to } = view.state.selection.main;

          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: from + text.length },
          });
          view.focus();
        },
        focus: () => {
          viewRef.current?.focus();
        },
      }),
      [],
    );

    /**
     * Applies one toolbar edit and returns focus to the document.
     *
     * Focus matters more than it looks: clicking a toolbar button moves focus
     * to the button, so without this the caret the edit just placed would be
     * invisible and the next keystroke would go nowhere useful.
     */
    const applyToolbarAction = (apply: (typeof TOOLBAR_ACTIONS)[number]["apply"]) => {
      const view = viewRef.current;

      if (view === null) {
        return;
      }

      const { from, to } = view.state.selection.main;
      const edit = apply(view.state.doc.toString(), from, to);

      view.dispatch({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        selection: { anchor: edit.anchor, head: edit.head },
      });
      view.focus();
    };

    const handleModeChange = (next: string) => {
      // The toggle group reports "" when the active item is pressed again;
      // a mode is always required, so that is ignored.
      if (next === "" || !MARKDOWN_EDITOR_MODES.includes(next as MarkdownEditorMode)) {
        return;
      }

      const nextMode = next as MarkdownEditorMode;

      if (controlledMode === undefined) {
        setUncontrolledMode(nextMode);
      }

      onModeChange?.(nextMode);
    };

    return (
      <div className={cn("flex min-h-0 flex-col", className)}>
        <CardHeader className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          {header}

          <ScrollArea
            variant="overlay"
            orientation="horizontal"
            className="min-w-0 flex-1"
            viewportProps={{ "aria-label": "Formatting controls", tabIndex: 0 }}
          >
            <div className="flex min-w-max items-center justify-end gap-1">
              {TOOLBAR_ACTIONS.map((action) => (
                <ActionTooltip key={action.key} label={action.label}>
                  <Button
                    aria-label={action.label}
                    className="size-8"
                    disabled={readOnly}
                    onClick={() => {
                      applyToolbarAction(action.apply);
                    }}
                    size="icon"
                    title={action.label}
                    type="button"
                    variant="ghost"
                  >
                    <action.icon aria-hidden="true" className="size-4" />
                  </Button>
                </ActionTooltip>
              ))}

              {actions}

              <ToggleGroup
                aria-label={`${label} view mode`}
                className="ml-1"
                onValueChange={handleModeChange}
                size="sm"
                type="single"
                value={mode}
                variant="default"
              >
                {MARKDOWN_EDITOR_MODES.map((editorMode) => (
                  <ToggleGroupItem key={editorMode} value={editorMode}>
                    {MODE_LABELS[editorMode]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </ScrollArea>
        </CardHeader>

        <Card
          size="sm"
          className={cn(
            "relative m-4 flex min-h-0 flex-col gap-0 rounded-none border-0 bg-black/25 p-0 shadow-none ring-0",
            expanded ? "h-auto" : "flex-1 overflow-hidden",
            editorClassName,
          )}
          ref={boxRef}
          style={
            expanded && expandedMinHeight !== null
              ? { minHeight: `${expandedMinHeight}px` }
              : undefined
          }
        >
          <ScrollArea
            variant="overlay"
            orientation="both"
            className={
              expanded ? "h-auto [&>[data-slot=scroll-area-viewport]]:h-auto" : "min-h-0 flex-1"
            }
            viewportProps={{ "aria-label": "Post body scroll", tabIndex: 0 }}
          >
            <div className="min-h-full" ref={hostRef} />
          </ScrollArea>

          {expandable ? (
            <div className="pointer-events-none absolute right-0 bottom-0 flex justify-end p-2">
              <Button
                aria-label={expanded ? "Shrink the editor" : "Expand the editor"}
                aria-pressed={expanded}
                className="pointer-events-auto size-8 bg-background/90 backdrop-blur-sm"
                onClick={() => {
                  const next = !expanded;

                  setExpandedMinHeight(
                    next ? (boxRef.current?.getBoundingClientRect().height ?? null) : null,
                  );
                  setExpanded(next);
                  onExpandedChange?.(next);
                }}
                size="icon"
                title={expanded ? "Shrink the editor" : "Expand the editor"}
                type="button"
                variant="outline"
              >
                {expanded ? (
                  <RiCollapseDiagonalLine aria-hidden="true" className="size-4" />
                ) : (
                  <RiExpandDiagonalLine aria-hidden="true" className="size-4" />
                )}
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    );
  },
);
