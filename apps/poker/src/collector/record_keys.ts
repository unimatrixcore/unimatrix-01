/** Shared metadata drives the recording transport labels and keyboard dispatch. */
export const recordActions = Object.freeze({
  capture: { label: "Capture", hint: "Space / C", ariaKeys: "Space C", keys: [" ", "c"] },
  toggle: { label: "Record", hint: "W", ariaKeys: "W", keys: ["w"] },
  stop: { label: "Stop", hint: "Esc", ariaKeys: "Escape", keys: ["escape"] },
} as const);
export const reviewActions = Object.freeze({
  accept: { label: "Accept and advance", hint: "Ctrl+Enter" },
  edit: { label: "Use and edit", hint: "Alt+Tab" },
  save: { label: "Save correction and advance", hint: "Enter" },
} as const);
export type RecordCommand = keyof typeof recordActions;
export interface RecordKeyStroke {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}
export interface RecordTargetContext {
  editable: boolean;
  nativeSpace: boolean;
}
export interface RecordKeyContext extends RecordTargetContext {
  collection: boolean;
  modalOpen: boolean;
  popoverOpen: boolean;
  recording: boolean;
  captureBusy: boolean;
  previewActive: boolean;
}
export function targetContext(target: EventTarget | null): RecordTargetContext {
  if (!(target instanceof Element)) return { editable: false, nativeSpace: false };
  return {
    editable: !!target.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
    ),
    nativeSpace: !!target.closest('button,summary,[role="button"],a[href]'),
  };
}
export function resolveKey(
  event: RecordKeyStroke,
  context: RecordKeyContext,
): RecordCommand | null {
  if (
    !context.collection ||
    context.editable ||
    context.modalOpen ||
    context.popoverOpen ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return null;
  const key = event.key.toLowerCase();
  if (recordActions.stop.keys.some((value) => value === key))
    return context.recording || context.captureBusy || context.previewActive ? "stop" : null;
  if (recordActions.toggle.keys.some((value) => value === key)) return "toggle";
  if (recordActions.capture.keys.some((value) => value === key) && key !== " ") return "capture";
  if ((event.code === "Space" || key === " ") && !context.nativeSpace) return "capture";
  return null;
}
export const recordingKeys = Object.freeze({
  actions: recordActions,
  review: reviewActions,
  targetContext,
  resolveKey,
});
