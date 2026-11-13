import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { Monitor, Settings } from "lucide-react";
import { Button, cn, Kbd } from "@unimatrix/ui/public";
import { Popover, PopoverContent, PopoverTrigger } from "@unimatrix/ui/popover";
import { recordActions } from "./record_keys";
import "./recording_panel.css";

type RecordingState = "ready" | "watching" | "busy" | "paused" | "error";

export interface RecordingPanelProps {
  id?: string;
  className?: string;
  ariaLabel?: string;
  header?: ReactNode;
  status?: ReactNode;
  detail?: ReactNode;
  state?: RecordingState;
  statusSlot?: ReactNode;
  detailSlot?: ReactNode;
  source: ReactNode;
  capture: ReactNode;
  record: ReactNode;
  stop?: ReactNode;
  hints?: ReactNode;
  hintsId?: string;
}

/** Shared OCR Data transport layout. Controllers own the supplied actions. */
export function RecordingPanel({
  id,
  className,
  ariaLabel = "Recording transport",
  header,
  status,
  detail,
  state = "ready",
  statusSlot,
  detailSlot,
  source,
  capture,
  record,
  stop,
  hints,
  hintsId,
}: RecordingPanelProps) {
  return (
    <section
      id={id}
      className={cn("record-dock recording-panel", className)}
      aria-label={ariaLabel}
    >
      {header}
      <div className="capture-session-state">
        {statusSlot ?? (
          <span className="recording-status" role="status" aria-live="polite" data-state={state}>
            {status}
          </span>
        )}
        {detailSlot ?? <span className="recording-status-detail">{detail}</span>}
      </div>
      <div className="record-dock-controls" data-has-stop={!!stop}>
        <div className="recording-control-slot recording-source-slot">{source}</div>
        <div className="recording-control-slot">{capture}</div>
        <div className="recording-control-slot">{record}</div>
        {stop && <div className="recording-control-slot">{stop}</div>}
      </div>
      {hints ?? (
        <p id={hintsId} className="record-key-hints">
          <span>
            <Kbd>{recordActions.capture.hint}</Kbd> capture
          </span>
          <span>
            <Kbd>{recordActions.toggle.hint}</Kbd> record / pause
          </span>
          <span>
            <Kbd>{recordActions.stop.hint}</Kbd> stop
          </span>
        </p>
      )}
    </section>
  );
}

export interface RecordingSourceProps {
  id?: string;
  label: ReactNode;
  labelId?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  ariaLabel?: string;
}

const sourceControllers = new Map<string, (open: boolean) => void>();

/** Bridge the native OCR controller to the shared controlled popup. */
export function setRecordingSourceOpen(id: string, open: boolean) {
  const controller = sourceControllers.get(id);
  if (!controller) return false;
  // The legacy collector's imperative callbacks expect the source state to be
  // updated before their next DOM query, just like its original details toggle.
  flushSync(() => {
    controller(open);
  });
  return true;
}

function RecordingSourceContent({
  element,
  parking,
}: {
  element: HTMLDivElement;
  parking: RefObject<HTMLDivElement | null>;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.appendChild(element);
    return () => {
      parking.current?.appendChild(element);
    };
  }, [element, parking]);
  return <div className="recording-native-slot" ref={host} />;
}

/** Both tabs use the same source toggle, standard gear, and settings surface. */
export function RecordingSource({
  id,
  label,
  labelId,
  children,
  defaultOpen,
  ariaLabel = "Capture source and recording settings",
}: RecordingSourceProps) {
  const generatedId = useId();
  const sourceId = id || generatedId;
  const [open, setOpen] = useState(!!defaultOpen);
  const parking = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [content] = useState(() => {
    const element = document.createElement("div");
    element.className = "recording-native-slot";
    return element;
  });
  useLayoutEffect(() => {
    sourceControllers.set(sourceId, setOpen);
    if (!content.parentNode) parking.current?.appendChild(content);
    return () => {
      sourceControllers.delete(sourceId);
      content.remove();
    };
  }, [sourceId, content]);
  return (
    <div id={id} className="watch-settings" data-recording-source-open={open}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            ref={trigger}
            variant="outline"
            className="dock-source-toggle"
            data-recording-source-trigger
            aria-label={ariaLabel}
            title={ariaLabel}
          >
            <Monitor size={16} aria-hidden="true" />
            <span id={labelId} className="recording-source-name">
              {label}
            </span>
            <Settings size={16} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          id={id ? `${id}-panel` : undefined}
          side="top"
          align="start"
          sideOffset={12}
          collisionPadding={16}
          data-recording-source-panel={sourceId}
          className="recording-settings-popover rounded-none border-0 ring-0 animate-none transition-none"
          forceMount
          hidden={!open}
          onOpenAutoFocus={(event) => {
            if (!open) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (!open) return;
            // The force-mounted popup keeps native controller fields alive.
            // Restore keyboard focus explicitly instead of waiting for Radix's
            // deferred FocusScope cleanup to discover the previous active node.
            event.preventDefault();
            flushSync(() => {
              setOpen(false);
            });
            trigger.current?.focus();
          }}
        >
          <RecordingSourceContent element={content} parking={parking} />
        </PopoverContent>
      </Popover>
      <div ref={parking} hidden aria-hidden="true" />
      {createPortal(children, content)}
    </div>
  );
}

/** Adopt native controller nodes without cloning IDs, state, or listeners. */
export function NativeRecordingSlot({ element }: { element: HTMLElement }) {
  const host = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    host.current?.appendChild(element);
  }, [element]);
  return <span className="recording-native-slot" ref={host} />;
}
