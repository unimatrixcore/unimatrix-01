import { renderDatasetPicker } from "./dataset_picker";
import {
  decorateIconButton,
  enhanceCardCheckboxes,
  iconForButton,
  installCropPreview,
} from "./review_controls";
import { WorkspaceTopbar } from "./workspace_topbar";
import { CaptureEmptyState } from "./capture_empty_state";
import { enhanceFormControls } from "./form_controls";
import { mountToolShell } from "./tool_shell";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  Badge,
  Button,
  Input,
  Kbd,
  ReviewSuggestion,
  createGamificationEffects,
  getGamificationFeedbackColor,
  createTextTransition,
  createModelIcon,
  DEFAULT_REVIEW_REWARD_RULES,
  classifyReviewReward,
  createAwardLedger,
  awardSample,
  restoreSampleAward,
  snapshotAwardLedger,
  restoreAwardLedger,
  createReadClock,
  pauseReadClock,
  resumeReadClock,
  readClockElapsedMs,
  snapshotReadClock,
  restoreReadClock,
} from "@unimatrix/ui/public";
import type { ComponentProps, CSSProperties } from "react";
import { recordingKeys, recordActions, reviewActions } from "./record_keys";
import { enhanceCollectionMenus, disposeMenus, closeMenus } from "./collection_card_menu";
import {
  NativeRecordingSlot,
  RecordingPanel,
  RecordingSource,
  setRecordingSourceOpen,
} from "./recording_panel";

type ButtonVariant = ComponentProps<typeof Button>["variant"];

const reviewGamification = Object.freeze({
  DEFAULT_REVIEW_REWARD_RULES,
  classifyReviewReward,
  createAwardLedger,
  awardSample,
  restoreSampleAward,
  snapshotAwardLedger,
  restoreAwardLedger,
  createReadClock,
  pauseReadClock,
  resumeReadClock,
  readClockElapsedMs,
  snapshotReadClock,
  restoreReadClock,
});

declare global {
  interface Window {
    CollectorSharedUi: {
      enhance: typeof enhance;
      renderDatasetPicker: typeof renderDatasetPicker;
      reviewGamification: typeof reviewGamification;
      recordingKeys: typeof recordingKeys;
      createGamificationEffects: typeof createGamificationEffects;
      getGamificationFeedbackColor: typeof getGamificationFeedbackColor;
      disposeMenus: typeof disposeMenus;
      closeMenus: typeof closeMenus;
      createTextTransition: typeof createTextTransition;
      setRecordingSourceOpen: typeof setRecordingSourceOpen;
    };
  }
}

function inlineStyle(node: HTMLElement): CSSProperties {
  return Object.fromEntries(
    Array.from(node.style).map((property) => [
      property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      node.style.getPropertyValue(property),
    ]),
  );
}

// The collector remains a native DOM application. Each island mounts once and
// then leaves its uncontrolled node to the existing dataset/review handlers.
function mount(node: HTMLElement, render: () => React.ReactNode) {
  const host = document.createElement("span");
  host.className = "shared-ui-island";
  node.replaceWith(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(render());
  });
  return host.firstElementChild as HTMLElement;
}

const keyboardActions: Record<string, [string, string]> = {
  "model-use": [reviewActions.edit.label, reviewActions.edit.hint],
  "model-accept": [reviewActions.accept.label, reviewActions.accept.hint],
  "label-save": [reviewActions.save.label, reviewActions.save.hint],
};

export function enhance(container: ParentNode = document) {
  enhanceFormControls(container);
  enhanceCardCheckboxes(container);
  enhanceCollectionMenus(container);
  for (const panel of container.querySelectorAll<HTMLElement>(
    ".saved-model-assist:not([data-shared-review])",
  )) {
    const filename = panel.id.slice("db-model-".length);
    const onUse = panel.querySelector<HTMLButtonElement>(
      `[id="db-model-use-${filename}"]`,
    )?.onclick;
    const onAccept = panel.querySelector<HTMLButtonElement>(
      `[id="db-model-accept-${filename}"]`,
    )?.onclick;
    const onRetry = panel.querySelector<HTMLButtonElement>(
      `[id="db-model-retry-${filename}"]`,
    )?.onclick;
    const onKeydown = panel.onkeydown;
    const rendered = mount(panel, () => (
      <ReviewSuggestion
        state="empty"
        rawText={null}
        suggestedText={null}
        statusText="Request a suggestion for this saved crop"
        canAccept={false}
        className="saved-model-assist"
        actionLabels={{ use: "Use and edit", accept: "Accept", retry: "Suggest" }}
        shortcutLabels={{ use: reviewActions.edit.hint, accept: reviewActions.accept.hint }}
        ids={{
          root: panel.id,
          rawText: `db-model-raw-${filename}`,
          suggestedText: `db-model-text-${filename}`,
          status: `db-model-state-${filename}`,
          use: `db-model-use-${filename}`,
          accept: `db-model-accept-${filename}`,
          retry: `db-model-retry-${filename}`,
        }}
      />
    ));
    // Native handlers deliberately own these controls after this one-time mount.
    // React's initial disabled props must not gate later native state changes.
    const handlers = { use: onUse, accept: onAccept, retry: onRetry };
    for (const [action, handler] of Object.entries(handlers)) {
      const button = rendered.querySelector<HTMLButtonElement>(
        `[id="db-model-${action}-${filename}"]`,
      );
      if (button && handler) button.onclick = handler;
    }
    const hints = document.createElement("p");
    hints.className = "review-key-hints";
    rendered.appendChild(hints);
    const hintRoot = createRoot(hints);
    flushSync(() => {
      hintRoot.render(
        <span>
          <Kbd>{reviewActions.save.hint}</Kbd> save
        </span>,
      );
    });
    rendered.dataset.sharedReview = "true";
    rendered.onkeydown = onKeydown;
  }
  for (const node of container.querySelectorAll<HTMLButtonElement>("button:not([data-slot])")) {
    if (
      node.closest(".collection-card-menu, [data-poker-branch-control]") ||
      node.hasAttribute("data-recording-source-trigger")
    )
      continue;
    const variant: ButtonVariant = node.classList.contains("btn-danger")
      ? "destructive"
      : node.classList.contains("btn-primary") || node.classList.contains("btn-success")
        ? "default"
        : node.classList.contains("btn-ghost") ||
            node.classList.contains("dataset-icon") ||
            node.classList.contains("capture-icon")
          ? "ghost"
          : "outline";
    const action = keyboardActions[node.id];
    const icon = iconForButton(node);
    const initiallyHidden = node.classList.contains("hidden");
    const props = {
      id: node.id || undefined,
      type: node.type,
      title: node.title || undefined,
      "aria-label": node.getAttribute("aria-label") || undefined,
      // Visibility is native collector state. Passing hidden to cn() would merge
      // away the shared inline-flex utility, so revealing later would lose layout.
      className: [...node.classList].filter((name) => name !== "hidden").join(" "),
      disabled: node.disabled,
      style: inlineStyle(node),
      size:
        icon || node.classList.contains("dataset-icon") || node.classList.contains("capture-icon")
          ? ("icon-sm" as const)
          : ("sm" as const),
      variant,
    };
    // Preserve the existing explicitly authored inline action hooks as native
    // callbacks. Later initDom assignments keep controlling the same button IDs.
    const click = node.getAttribute("onclick");
    const nativeClick = node.onclick;
    const button = mount(node, () =>
      node.id === "capture-once" ? (
        <Button {...props} aria-keyshortcuts={recordActions.capture.ariaKeys}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8 4-2 3H3v13h18V7h-3l-2-3Z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          {recordActions.capture.label}
        </Button>
      ) : node.id === "watch-start" ? (
        <Button {...props} aria-keyshortcuts={recordActions.toggle.ariaKeys}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="6" />
          </svg>
          {recordActions.toggle.label}
        </Button>
      ) : node.id === "watch-stop" ? (
        <Button
          {...props}
          aria-label="Stop recording"
          aria-keyshortcuts={recordActions.stop.ariaKeys}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" />
          </svg>
          {recordActions.stop.label}
        </Button>
      ) : action ? (
        <Button {...props}>
          {action[0]} <Kbd>{action[1]}</Kbd>
        </Button>
      ) : (
        <Button {...props} dangerouslySetInnerHTML={{ __html: node.innerHTML }} />
      ),
    );
    if (icon) decorateIconButton(button, icon);
    button.classList.toggle("hidden", initiallyHidden);
    if (click) button.setAttribute("onclick", click);
    else if (nativeClick) button.onclick = nativeClick;
  }

  for (const id of ["count-frames-pill", "count-regions-pill"]) {
    const node = container.querySelector<HTMLElement>(`#${id}:not([data-slot=badge])`);
    if (node)
      mount(node, () => (
        <Badge id={id} variant="outline">
          {node.textContent}
        </Badge>
      ));
  }

  for (const node of container.querySelectorAll<HTMLElement>(
    ".shortcut-bar .kbd:not([data-slot=kbd])",
  )) {
    mount(node, () => <Kbd>{node.textContent}</Kbd>);
  }
}

// Preserve the original game-sized input and native handlers while consuming
// the shared Input surface, focus ring, typography and disabled state.
const answerInput = document.getElementById("label-input");
if (answerInput instanceof HTMLInputElement) {
  mount(answerInput, () => (
    <Input
      id="label-input"
      className="um-game-input"
      type="text"
      aria-label="Crop label"
      autoComplete="off"
      placeholder={answerInput.placeholder}
      defaultValue={answerInput.value}
    />
  ));
}

mountToolShell();

// Keep native game state and HUD nodes; shared primitives and motion style them.
document
  .querySelector("[data-model-icon]")
  ?.replaceWith(createModelIcon(document, "model-bot-icon"));
const recordHints = document.getElementById("record-key-hints");
if (recordHints) {
  const root = createRoot(recordHints);
  flushSync(() => {
    root.render(
      <>
        <span>
          <Kbd>{recordActions.capture.hint}</Kbd> capture
        </span>
        <span>
          <Kbd>{recordActions.toggle.hint}</Kbd> record / pause
        </span>
        <span>
          <Kbd>{recordActions.stop.hint}</Kbd> stop
        </span>
      </>,
    );
  });
}
const reviewHints = document.getElementById("review-edit-key-hints");
if (reviewHints) {
  const root = createRoot(reviewHints);
  flushSync(() => {
    root.render(
      <>
        <Kbd>{reviewActions.edit.hint}</Kbd> Edit model
      </>,
    );
  });
}
Object.defineProperty(window, "CollectorSharedUi", {
  value: {
    enhance,
    renderDatasetPicker,
    reviewGamification,
    recordingKeys,
    createGamificationEffects,
    getGamificationFeedbackColor,
    disposeMenus,
    closeMenus,
    createTextTransition,
    setRecordingSourceOpen,
  },
  configurable: true,
});
// Gameplay owns its React tree; native DOM replacement is only for OCR Data.
{
  enhance();
  installCropPreview();
  mountWorkspaceTopbar();
  const placeholder = document.getElementById("collection-placeholder");
  if (placeholder)
    mount(placeholder, () => (
      <CaptureEmptyState
        id="collection-placeholder"
        title="No crops collected"
        description="Press Space or C for one frame. Press W to record new crops."
      />
    ));
  mountRecordingPanel();
}
document.documentElement.dataset.collectorUi = "@unimatrix/ui";

function mountRecordingPanel() {
  const panel = document.getElementById("record-dock");
  if (!panel || panel.dataset.sharedRecording) return;
  const header = panel.querySelector<HTMLElement>(".collection-queuebar");
  const status = panel.querySelector<HTMLElement>("#watch-status");
  const detail = panel.querySelector<HTMLElement>("#watch-status-detail");
  const settings = panel.querySelector<HTMLDetailsElement>("#watch-settings");
  const contents = settings?.querySelector<HTMLElement>(".watch-settings-panel");
  const capture = panel.querySelector<HTMLElement>("#capture-once");
  const record = panel.querySelector<HTMLElement>(".record-toggle-slot");
  const hints = panel.querySelector<HTMLElement>("#record-key-hints");
  if (!header || !status || !detail || !settings || !contents || !capture || !record || !hints)
    return;
  const label = settings.querySelector("#record-source-name")?.textContent || "Source";
  const wasOpen = settings.open;
  // Keep every native field/action and enhanced island in place. Only their
  // layout is adopted into the same shared React surface used by Gameplay.
  contents.className = "recording-native-slot";
  const captureIsland = capture.parentElement?.classList.contains("shared-ui-island")
    ? capture.parentElement
    : capture;
  const host = document.createElement("div");
  host.className = "recording-panel-host";
  panel.replaceWith(host);
  flushSync(() => {
    createRoot(host).render(
      <RecordingPanel
        id="record-dock"
        header={<NativeRecordingSlot element={header} />}
        statusSlot={<NativeRecordingSlot element={status} />}
        detailSlot={<NativeRecordingSlot element={detail} />}
        source={
          <RecordingSource
            id="watch-settings"
            label={label}
            labelId="record-source-name"
            defaultOpen={wasOpen}
          >
            <NativeRecordingSlot element={contents} />
          </RecordingSource>
        }
        capture={<NativeRecordingSlot element={captureIsland} />}
        record={<NativeRecordingSlot element={record} />}
        hints={<NativeRecordingSlot element={hints} />}
      />,
    );
  });
  document.getElementById("record-dock")!.dataset.sharedRecording = "true";
}

function mountWorkspaceTopbar() {
  const header = document.getElementById("workflow-panel");
  const navigation = header?.querySelector<HTMLElement>(".stepper");
  const actions = header?.querySelector<HTMLElement>(".stepper-panel-actions");
  if (!header || !navigation || !actions) return;
  // Keep the existing enhanced controls and native workflow handlers intact.
  actions.className = "recording-native-slot";
  mount(header, () => (
    <WorkspaceTopbar
      id="workflow-panel"
      ariaLabel="Workflow Navigation"
      leading={<NativeRecordingSlot element={navigation} />}
      actions={<NativeRecordingSlot element={actions} />}
    />
  ));
}
