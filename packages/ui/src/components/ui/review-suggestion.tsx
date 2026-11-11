import { cn } from "../../lib/utils.js";
import { Button } from "./button.js";
import { Kbd } from "./kbd.js";

export interface ReviewSuggestionIds {
  root?: string;
  rawText?: string;
  suggestedText?: string;
  status?: string;
  use?: string;
  accept?: string;
  retry?: string;
}

export type ReviewSuggestionState = "loading" | "ready" | "error" | "empty";
export interface ReviewSuggestionActionLabels {
  use?: string;
  accept?: string;
  retry?: string;
}
export interface ReviewSuggestionShortcutLabels {
  use?: string;
  accept?: string;
}

export interface ReviewSuggestionProps {
  rawText: string | null;
  suggestedText: string | null;
  state: ReviewSuggestionState;
  statusText: string;
  onUse?: () => void;
  onAccept?: () => void;
  onRetry?: () => void;
  canAccept?: boolean;
  busy?: boolean;
  actionLabels?: ReviewSuggestionActionLabels;
  shortcutLabels?: ReviewSuggestionShortcutLabels;
  className?: string;
  ids?: ReviewSuggestionIds;
}

function displayText(text: string | null): string {
  return text === null ? "Not available" : text === "" ? "Blank" : text;
}

export function ReviewSuggestion({
  rawText,
  suggestedText,
  state,
  statusText,
  onUse,
  onAccept,
  onRetry,
  canAccept = false,
  busy = false,
  actionLabels,
  shortcutLabels,
  className,
  ids,
}: ReviewSuggestionProps) {
  return (
    <section
      id={ids?.root}
      aria-label="Review suggestion"
      aria-busy={busy || state === "loading"}
      data-state={state}
      className={cn("space-y-3 border border-border bg-background p-3 text-sm", className)}
    >
      <dl className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">Raw text</dt>
          <dd id={ids?.rawText} className="whitespace-pre-wrap break-words font-mono">
            {displayText(rawText)}
          </dd>
        </div>
        <div className="min-w-0 space-y-1">
          <dt className="text-xs text-muted-foreground">Suggested text</dt>
          <dd id={ids?.suggestedText} className="whitespace-pre-wrap break-words font-mono">
            {displayText(suggestedText)}
          </dd>
        </div>
      </dl>
      <p
        id={ids?.status}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-xs text-muted-foreground"
      >
        {statusText}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          id={ids?.use}
          type="button"
          variant="outline"
          size="sm"
          onClick={onUse}
          disabled={busy || state !== "ready" || suggestedText === null}
        >
          {actionLabels?.use ?? "Use suggestion"} <Kbd>{shortcutLabels?.use ?? "Ctrl+Space"}</Kbd>
        </Button>
        <Button
          id={ids?.accept}
          type="button"
          size="sm"
          onClick={onAccept}
          disabled={busy || !canAccept}
        >
          {actionLabels?.accept ?? "Accept"} <Kbd>{shortcutLabels?.accept ?? "Ctrl+Enter"}</Kbd>
        </Button>
        <Button
          id={ids?.retry}
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRetry}
          disabled={busy || state === "loading"}
        >
          {actionLabels?.retry ?? "Retry"}
        </Button>
      </div>
    </section>
  );
}
