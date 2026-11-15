import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, Input, Badge } from "@unimatrix/ui/public";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unimatrix/ui/editor";
import { InstantVirtualList, useBackgroundList } from "@unimatrix/instant-list";
import {
  Play,
  Pause,
  RefreshCw,
  Check,
  Eye,
  X,
  CircleHelp,
  Clock,
  TriangleAlert,
  Sparkles,
  ListFilter,
} from "lucide-react";
import {
  pokerGameplayAiItemsSchema,
  pokerGameplayAiStatusSchema,
  pokerGameplayAiPrepareSchema,
  pokerGameplayAiResumeRequestSchema,
  pokerGameplayAiReviewResponseSchema,
  type PokerGameplayAiItem,
  type PokerGameplayAiJob,
  pokerOcrValueSchema,
} from "@unimatrix/shared";
import "./gameplay-ai-review.css";
import { mediaUrl } from "../lib/native-transport";
import { gameplayErrorMessage } from "./gameplay-errors";

const failure = (value: unknown) => gameplayErrorMessage(value, "Unable to load review data.");
export async function gameplayAiRequest(
  path: string,
  data?: object,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/gameplay/ai/${path}`, {
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
    ...(signal ? { signal } : {}),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Request failed (${response.status})`,
    );
  return value;
}

export function GameplayIconAction({
  label,
  children,
  ...props
}: {
  label: string;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} size="icon-sm" aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

const reviewSettings = new Map<string, { requestLimit: string; autoCorrect: boolean }>();

type Filter = "all" | "pending" | "completed" | "manual" | "ambiguous" | "error";
const filters: { id: Filter; label: string; icon: ReactNode }[] = [
  { id: "manual", label: "Needs review", icon: <TriangleAlert size={15} /> },
  { id: "pending", label: "Pending", icon: <Clock size={15} /> },
  { id: "completed", label: "Verified", icon: <Check size={15} /> },
  { id: "ambiguous", label: "Ambiguous", icon: <CircleHelp size={15} /> },
  { id: "error", label: "Errors", icon: <X size={15} /> },
  { id: "all", label: "All crops", icon: <ListFilter size={15} /> },
];
const stateLabel = (state: string) =>
  ({
    unchanged: "Verified",
    legacy_verified: "Verified · Legacy",
    corrected: "Corrected",
    manual: "Manual",
    flagged: "Needs review",
    conflict: "Conflict",
    pending: "Pending",
    ambiguous: "Ambiguous",
    error: "Error",
    quarantined: "Quarantined",
  })[state] || state;
const itemId = (item: PokerGameplayAiItem) => item.id;
const workId = (item: PokerGameplayAiItem) => item.work_key || item.id;
const reviewed = (item: PokerGameplayAiItem) =>
  ["unchanged", "corrected", "manual", "legacy_verified"].includes(item.state);
const editableReading = (item: PokerGameplayAiItem) =>
  reviewed(item) ? item.label : (item.proposed_text ?? item.label);
const suits = [
  { value: "d", glyph: "♦", name: "Diamonds" },
  { value: "h", glyph: "♥︎", name: "Hearts" },
  { value: "c", glyph: "♣", name: "Clubs" },
  { value: "s", glyph: "♠", name: "Spades" },
] as const;

function GameplayReviewCrop({ item }: { item: PokerGameplayAiItem }) {
  if (item.crop_available === false || !item.crop_url) {
    return (
      <span className="gameplay-ai-crop-unavailable">
        <CircleHelp size={20} aria-hidden="true" />
        <span>Crop unavailable</span>
      </span>
    );
  }
  const guide = item.guide;
  if (!guide) return <img src={mediaUrl(item.crop_url)} alt={`${item.region_id} crop`} />;
  const { crop_width: width, crop_height: height, anchor } = guide;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <svg
          className="gameplay-ai-guided-crop"
          viewBox={`-12 -12 ${width + 24} ${height + 24}`}
          role="img"
          aria-label={`${item.region_id} crop with OCR target`}
          tabIndex={0}
        >
          <image href={mediaUrl(item.crop_url)} x={0} y={0} width={width} height={height} />
          <path d={`M ${anchor.x - 4} -10 L ${anchor.x + 4} -10 L ${anchor.x} -2 Z`} />
          <path d={`M -10 ${anchor.y - 4} L -10 ${anchor.y + 4} L -2 ${anchor.y} Z`} />
        </svg>
      </TooltipTrigger>
      <TooltipContent>OCR target</TooltipContent>
    </Tooltip>
  );
}

export function GameplayAiReview({
  sessionId,
  frameCount,
  active,
  onInitialReady,
}: {
  sessionId: string;
  frameCount: number;
  active: boolean;
  onInitialReady?: () => void;
}) {
  const [job, setJob] = useState<PokerGameplayAiJob | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const initialReady = useRef(onInitialReady);
  initialReady.current = onInitialReady;
  const [filter, setFilter] = useState<Filter>("manual");
  const [selectedId, setSelectedId] = useState("");
  const [label, setLabel] = useState("");
  const [blank, setBlank] = useState(false);
  const [context, setContext] = useState(false);
  const [occurrencesOpen, setOccurrencesOpen] = useState(false);
  const [occurrenceId, setOccurrenceId] = useState("");
  const [autoCorrect, setAutoCorrect] = useState(true);
  const [requestLimit, setRequestLimit] = useState("100");
  const maxRequests = Number(requestLimit);
  const validRequestLimit =
    Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 10000;
  function updateSettings(limit: string, correction: boolean) {
    setRequestLimit(limit);
    setAutoCorrect(correction);
    reviewSettings.set(`${sessionId}:${job?.id || ""}`, {
      requestLimit: limit,
      autoCorrect: correction,
    });
  }
  const [busy, setBusy] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [phase, setPhase] = useState<"idle" | "preparing" | "starting">("idle");
  const preparing = phase === "preparing" || job?.state === "preparing";
  const preparationVisible = preparing || job?.state === "paused";
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const refreshStatus = useRef<() => void>(() => {});
  const [notice, setNotice] = useState("");
  const scope = useRef(sessionId);
  scope.current = sessionId;
  const operationRevision = useRef(0);
  const committedRevision = useRef(0);
  const pausePending = useRef(false);
  const statusSequence = useRef(0);
  const appliedStatusSequence = useRef(0);
  const selectedRevision = useRef("");
  const editingRevision = useRef(0);
  const editingOccurrence = useRef("");
  const statusSignature = useRef("");
  const settingsJob = useRef("");
  const list = useBackgroundList<PokerGameplayAiItem, string>({
    queryKey: ["gameplay-ai", sessionId, filter],
    getItemId: workId,
    enabled: active && !!sessionId && job?.state === "completed" && phase === "idle",
    pageSize: 100,
    fetchPage: async ({ cursor, limit, signal }) => {
      const query = new URLSearchParams({
        session_id: sessionId,
        filter,
        grouped: "true",
        limit: String(limit),
        ...(cursor === null ? {} : { cursor }),
      });
      const page = pokerGameplayAiItemsSchema.parse(
        await gameplayAiRequest(`items?${query}`, undefined, signal),
      );
      return { items: page.items, nextCursor: page.nextCursor, total: page.total, meta: page.meta };
    },
  });
  const [savedSnapshot, setSavedSnapshot] = useState<PokerGameplayAiItem[] | null>(null);
  const saving = useRef(false);
  const [acknowledgedItem, setAcknowledgedItem] = useState<PokerGameplayAiItem | null>(null);
  const savedSelection = useRef<string[]>([]);
  const items = savedSnapshot ?? list.items;
  const selectedGroup = items.find((item) => workId(item) === selectedId) || items[0];
  const groupKey = selectedGroup ? workId(selectedGroup) : "";
  const occurrences = useBackgroundList<PokerGameplayAiItem, string>({
    queryKey: ["gameplay-ai-occurrences", sessionId, groupKey],
    getItemId: itemId,
    enabled: active && occurrencesOpen && !!groupKey,
    pageSize: 20,
    maxBackgroundItems: 20,
    fetchPage: async ({ cursor, limit, signal }) => {
      const query = new URLSearchParams({
        session_id: sessionId,
        grouped: "false",
        filter: "all",
        work_key: groupKey,
        limit: String(limit),
        ...(cursor === null ? {} : { cursor }),
      });
      const page = pokerGameplayAiItemsSchema.parse(
        await gameplayAiRequest(`items?${query}`, undefined, signal),
      );
      return { items: page.items, nextCursor: page.nextCursor, total: page.total, meta: page.meta };
    },
  });
  const selectedOccurrence =
    occurrences.items.find((item) => item.id === occurrenceId) || selectedGroup;
  const selected =
    acknowledgedItem?.id === selectedOccurrence?.id ? acknowledgedItem : selectedOccurrence;
  useEffect(() => {
    if (statusLoaded && (job?.state !== "completed" || list.isSuccess || list.isError))
      initialReady.current?.();
  }, [statusLoaded, job?.state, list.isSuccess, list.isError]);
  const savedSnapshotRef = useRef(savedSnapshot);
  savedSnapshotRef.current = savedSnapshot;
  const refreshItems = useRef<() => Promise<PokerGameplayAiItem[] | null>>(() =>
    Promise.resolve(null),
  );
  refreshItems.current = async () => {
    const refreshed = await list.refetch();
    if (refreshed.isError) throw refreshed.error;
    if (occurrencesOpen) {
      const refreshedOccurrences = await occurrences.refetch();
      if (refreshedOccurrences.isError) throw refreshedOccurrences.error;
    }
    return refreshed.data?.pages.flatMap((page) => page.items) ?? [];
  };
  const refetch = useRef<() => void>(() => {});
  refetch.current = () => {
    void list.refetch({ cancelRefetch: false });
    if (occurrencesOpen) void occurrences.refetch({ cancelRefetch: false });
  };
  function applyJob(next: PokerGameplayAiJob | null, revision: number, sequence: number) {
    if (
      saving.current ||
      revision !== operationRevision.current ||
      sequence < appliedStatusSequence.current
    )
      return false;
    appliedStatusSequence.current = sequence;
    setJob((previous) =>
      next && previous?.id === next.id && !next.group_counts
        ? { ...next, group_counts: previous.group_counts }
        : next,
    );
    if (next?.preparation?.pause_requested) {
      pausePending.current = true;
      setPauseRequested(true);
    } else if (!next || !["preparing", "queued", "running", "cancelling"].includes(next.state)) {
      pausePending.current = false;
      setPauseRequested(false);
    }
    return true;
  }
  useEffect(() => {
    setJob(null);
    setSavedSnapshot(null);
    setAcknowledgedItem(null);
    saving.current = false;
    setStatusLoaded(false);
    setSelectedId("");
    setError("");
    setStatusError("");
    setNotice("");
    setContext(false);
    setOccurrenceId("");
    setOccurrencesOpen(false);
    setPhase("idle");
    setBusy(false);
    pausePending.current = false;
    setPauseRequested(false);
    settingsJob.current = "";
    setRequestLimit("100");
    setAutoCorrect(true);
    statusSignature.current = "";
    selectedRevision.current = "";
    return () => {
      operationRevision.current += 1;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!active || !sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let refreshQueued = false;
    async function poll(explicit = false) {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      inFlight = true;
      const revision = operationRevision.current;
      const commit = committedRevision.current;
      let reconciled = false;
      const sequence = ++statusSequence.current;
      try {
        const next = pokerGameplayAiStatusSchema.parse(
          await gameplayAiRequest(
            `status?${new URLSearchParams({ session_id: sessionId })}`,
            undefined,
            controller.signal,
          ),
        ).job;
        if (
          controller.signal.aborted ||
          revision !== operationRevision.current ||
          commit !== committedRevision.current ||
          saving.current
        )
          return;
        if (!saving.current && savedSnapshotRef.current) {
          if (!next || next.state !== "completed")
            throw new Error("Saved review status changed; refresh review data.");
          const refreshed = await refreshItems.current();
          if (
            controller.signal.aborted ||
            revision !== operationRevision.current ||
            commit !== committedRevision.current ||
            saving.current
          )
            return;
          if (refreshed) {
            setSelectedId((current) =>
              refreshed.some((row) => workId(row) === current)
                ? current
                : (savedSelection.current.find((key) =>
                    refreshed.some((row) => workId(row) === key),
                  ) ?? (refreshed[0] ? workId(refreshed[0]) : "")),
            );
            setSavedSnapshot(null);
            setAcknowledgedItem(null);
            reconciled = true;
          }
        }
        if (applyJob(next, revision, sequence)) {
          setStatusLoaded(true);
          setStatusError("");
          const settingsKey = `${sessionId}:${next?.id || ""}`;
          if (settingsJob.current !== settingsKey) {
            settingsJob.current = settingsKey;
            const draft = reviewSettings.get(settingsKey);
            setAutoCorrect(draft?.autoCorrect ?? next?.auto_correct ?? true);
            setRequestLimit(draft?.requestLimit ?? String(next?.max_requests ?? 100));
          }
          const signature = JSON.stringify(next);
          if (
            !reconciled &&
            next?.state === "completed" &&
            (explicit || (statusSignature.current && statusSignature.current !== signature))
          )
            refetch.current();
          statusSignature.current = signature;
        }
      } catch (reason) {
        if (
          !controller.signal.aborted &&
          revision === operationRevision.current &&
          commit === committedRevision.current &&
          sequence >= appliedStatusSequence.current
        ) {
          setStatusLoaded(true);
          setStatusError(failure(reason));
        }
      } finally {
        inFlight = false;
        if (refreshQueued && !controller.signal.aborted) {
          refreshQueued = false;
          void poll(true);
        } else if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, 2000);
      }
    }
    const refresh = () => {
      void poll(true);
    };
    refreshStatus.current = refresh;
    void poll();
    return () => {
      if (refreshStatus.current === refresh) refreshStatus.current = () => {};
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, sessionId]);
  useEffect(() => {
    const identity = `${groupKey}:${occurrenceId}`;
    if (identity === selectedRevision.current) return;
    selectedRevision.current = identity;
    editingRevision.current = selected?.revision || 0;
    editingOccurrence.current = selected?.id || "";
    setLabel(selected ? editableReading(selected) : "");
    setBlank(
      selected?.label === "" &&
        ["unchanged", "corrected", "manual", "legacy_verified"].includes(selected.state),
    );
    setContext(false);
  }, [selected, groupKey, occurrenceId]);
  useEffect(() => {
    setOccurrenceId("");
    setOccurrencesOpen(false);
  }, [groupKey]);
  const counts = job?.counts;
  const groupCounts = job?.group_counts;
  const completedGroups = groupCounts
    ? groupCounts.verified + groupCounts.corrected + groupCounts.manual
    : 0;
  const running = !!job && ["queued", "running", "cancelling"].includes(job.state);
  const resumable = !!job && ["cancelled", "interrupted", "failed"].includes(job.state);
  const recoveryCandidate =
    job && ["paused", "prepared"].includes(job.state) && !job.scope.recover_from_job_id
      ? job.recovery_candidate_job_id
      : null;
  const remainingGroups = groupCounts
    ? groupCounts.needs_review + groupCounts.ambiguous + groupCounts.error + groupCounts.pending
    : null;
  async function operate(action: "start" | "stop" | "resume") {
    if (!statusLoaded || statusError || job?.state === "completed" || saving.current) return;
    if (action !== "stop" && (busy || (job?.state === "prepared" && !recoveryCandidate))) return;
    if (action === "stop" && pausePending.current) return;
    if (
      action === "start" &&
      job &&
      !["paused", "quarantined"].includes(job.state) &&
      !recoveryCandidate
    )
      return;
    if (action === "resume" && !resumable) return;
    if (action === "stop" && !running && job?.state !== "preparing") return;
    if (action !== "stop" && !validRequestLimit) {
      setError("Request limit must be an integer from 1 to 10000.");
      return;
    }
    if (action === "resume" && maxRequests <= (job?.usage.requests || 0)) {
      setError("Increase the request limit before resuming.");
      return;
    }
    const recording = sessionId;
    const revision = ++operationRevision.current;
    let sequence = ++statusSequence.current;
    const isCurrent = () => scope.current === recording && operationRevision.current === revision;
    if (action === "stop") {
      pausePending.current = true;
      setPauseRequested(true);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let result: unknown;
      if (action === "start") {
        setPhase(job?.state === "prepared" ? "starting" : "preparing");
        const recoverySource =
          job?.state === "quarantined"
            ? job.id
            : job?.scope.recover_from_job_id || recoveryCandidate;
        const prepared = pokerGameplayAiPrepareSchema.parse(
          await gameplayAiRequest("prepare", {
            session_id: recording,
            review_after_prepare: true,
            auto_correct: autoCorrect,
            max_requests: maxRequests,
            ...(recoverySource ? { recover_from_job_id: recoverySource } : {}),
          }),
        );
        if (!isCurrent()) return;
        setPhase("starting");
        sequence = ++statusSequence.current;
        result = await gameplayAiRequest(
          `status?${new URLSearchParams({ session_id: recording })}`,
        );
        if (!isCurrent()) return;
        const ready = pokerGameplayAiStatusSchema.parse(result).job;
        if (ready && ready.id !== prepared.run_id && ready.id !== prepared.job_id)
          throw new Error("Prepared scope changed; refresh before starting review");
      } else
        result = await gameplayAiRequest(
          action,
          action === "resume"
            ? pokerGameplayAiResumeRequestSchema.parse({
                job_id: job?.id,
                max_requests: maxRequests,
              })
            : { job_id: job?.id },
        );
      if (isCurrent()) {
        applyJob(pokerGameplayAiStatusSchema.parse(result).job, revision, sequence);
        await list.refetch();
      }
    } catch (reason) {
      if (isCurrent()) {
        setError(failure(reason));
        if (action === "stop") {
          pausePending.current = false;
          setPauseRequested(false);
        }
      }
    } finally {
      if (isCurrent()) {
        setBusy(false);
        setPhase("idle");
      }
    }
  }
  async function save(action: "manual" | "ambiguous") {
    if (!selected || saving.current) return;
    const recording = sessionId;
    const current = selected;
    const index = items.findIndex((item) => workId(item) === groupKey);
    const candidates = [...items.slice(index + 1), ...items.slice(0, index).reverse()];
    const revision = ++operationRevision.current;
    const isCurrent = () => scope.current === recording && operationRevision.current === revision;
    if (current.id !== editingOccurrence.current) {
      setError("Reading changed; reload before correcting");
      return;
    }
    saving.current = true;
    setSavedSnapshot(items);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = pokerGameplayAiReviewResponseSchema.parse(
        await gameplayAiRequest("review", {
          occurrence_id: current.id,
          expected_revision: editingRevision.current,
          label:
            action === "manual"
              ? pokerOcrValueSchema(current.region_id, { allowBlank: blank }).parse(
                  blank ? "" : label,
                )
              : current.label,
          action,
        }),
      );
      if (!isCurrent()) return;
      committedRevision.current += 1;
      setAcknowledgedItem(result.item);
      savedSelection.current = [groupKey, ...candidates.map(workId)];
      editingRevision.current = result.revision;
      setNotice(
        `${result.affected_count} ${result.affected_count === 1 ? "occurrence updated" : "occurrences updated"}`,
      );
      editingOccurrence.current = result.item.id;
      // Occurrence acknowledgements cannot prove a grouped outcome or count delta.
      saving.current = false;
      setBusy(false);
      refreshStatus.current();
    } catch (reason) {
      if (isCurrent()) {
        setError(failure(reason));
        setSavedSnapshot(savedSnapshot);
      }
    } finally {
      if (isCurrent()) {
        saving.current = false;
        setBusy(false);
      }
    }
  }

  function filterCount(value: Filter) {
    if (!groupCounts) return "…";
    return value === "all"
      ? groupCounts.total
      : value === "completed"
        ? completedGroups
        : value === "manual"
          ? groupCounts.needs_review
          : groupCounts[value];
  }
  return (
    <TooltipProvider delayDuration={250}>
      <section className="gameplay-ai" aria-label="AI review">
        <div className="gameplay-ai-job">
          <div className="gameplay-ai-job-line">
            <span className="gameplay-ai-state">
              <i data-running={running || preparing} />
              {pauseRequested
                ? "Pausing"
                : preparing
                  ? "Extracting crops"
                  : phase === "starting"
                    ? "Starting ChatGPT review"
                    : job?.state === "completed"
                      ? "AI complete"
                      : running
                        ? "ChatGPT review"
                        : job
                          ? stateLabel(job.state)
                          : !statusLoaded
                            ? "Loading…"
                            : statusError
                              ? "Review unavailable"
                              : "Unverified"}
            </span>
            <div className="gameplay-ai-actions">
              <GameplayIconAction
                label={autoCorrect ? "Auto-correction enabled" : "Auto-correction disabled"}
                variant={autoCorrect ? "secondary" : "ghost"}
                aria-pressed={autoCorrect}
                disabled={running || preparing || busy}
                onClick={() => {
                  updateSettings(requestLimit, !autoCorrect);
                }}
              >
                <Sparkles size={16} />
              </GameplayIconAction>
              <GameplayIconAction
                label="Refresh review"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  refreshStatus.current();
                }}
              >
                <RefreshCw size={16} />
              </GameplayIconAction>
              {job?.state !== "completed" && (job?.state !== "prepared" || recoveryCandidate) && (
                <GameplayIconAction
                  label={
                    pauseRequested
                      ? preparing
                        ? "Pausing preparation"
                        : "Pausing review"
                      : preparing
                        ? job?.state === "preparing"
                          ? "Pause preparation"
                          : "Preparing review"
                        : recoveryCandidate
                          ? "Recheck review"
                          : job?.state === "paused"
                            ? "Resume preparation"
                            : running
                              ? "Pause review"
                              : resumable
                                ? "Resume review"
                                : job?.state === "quarantined"
                                  ? "Recheck review"
                                  : "Start review"
                  }
                  disabled={
                    !statusLoaded ||
                    !!statusError ||
                    !sessionId ||
                    !frameCount ||
                    pauseRequested ||
                    (preparing && job?.state !== "preparing") ||
                    (busy && job?.state !== "preparing")
                  }
                  onClick={() => {
                    void operate(
                      preparing && job?.state === "preparing"
                        ? "stop"
                        : running
                          ? "stop"
                          : job?.state === "paused"
                            ? "start"
                            : resumable
                              ? "resume"
                              : "start",
                    );
                  }}
                >
                  {running || preparing ? <Pause size={16} /> : <Play size={16} />}
                </GameplayIconAction>
              )}
            </div>
          </div>
          <progress
            aria-label={preparationVisible ? "Preparation progress" : "Verification progress"}
            {...(preparationVisible
              ? job?.preparation
                ? { value: job.preparation.processed_frames }
                : {}
              : { value: counts?.frames_completed || 0 })}
            max={
              preparationVisible
                ? job?.preparation?.total_frames || frameCount || 1
                : counts?.frames_total || frameCount || 1
            }
          />
          <div className="gameplay-ai-counts">
            {preparationVisible ? (
              <span>
                {job?.preparation
                  ? `${job.preparation.processed_frames} / ${job.preparation.total_frames} frames`
                  : `${frameCount} frames`}
              </span>
            ) : (
              <span>
                {job?.state === "completed"
                  ? remainingGroups === null
                    ? "Remaining groups unavailable"
                    : `${remainingGroups} groups remaining${groupCounts?.pending ? ` · ${groupCounts.pending} pending` : ""}`
                  : `${completedGroups} / ${groupCounts?.total ?? job?.scope.unique_crops ?? 0} unique crops`}
              </span>
            )}
          </div>
          <details className="gameplay-ai-details">
            <summary>Review details</summary>
            <label
              className="flex items-center gap-2 my-2"
              title="Cumulative provider requests for this review job"
            >
              Request limit
              <Input
                type="number"
                min={1}
                max={10000}
                step={1}
                className="h-7 w-24 text-xs"
                value={requestLimit}
                disabled={!statusLoaded || running || preparing || busy}
                aria-invalid={!validRequestLimit}
                onChange={(event) => {
                  updateSettings(event.target.value, autoCorrect);
                }}
              />
            </label>
            {job && (
              <span>
                {job.scope.unique_crops.toLocaleString()} unique crops ·{" "}
                {job.usage.exact_cache_hits.toLocaleString()} exact verified reuses ·{" "}
                {job.usage.near_cache_hits.toLocaleString()} proven near reuses ·{" "}
                {job.usage.requests} requests ·{" "}
                {(job.usage.input_tokens + job.usage.output_tokens).toLocaleString()} tokens
              </span>
            )}
          </details>
        </div>
        {error && (
          <div className="gameplay-ai-error" role="alert">
            {error}
          </div>
        )}
        {statusError && (
          <div className="gameplay-ai-error" role="alert">
            {statusError}
          </div>
        )}
        {job?.error && !error && (
          <div className="gameplay-ai-error" role="alert">
            {failure(new Error(job.error))}
          </div>
        )}
        {notice && (
          <div className="gameplay-ai-notice" role="status">
            {notice}
          </div>
        )}
        {job?.state === "completed" && phase === "idle" && (
          <div className="gameplay-ai-review-grid">
            <section className="gameplay-ai-queue" aria-label="Review queue">
              <div className="gameplay-ai-filters" role="group" aria-label="Review filters">
                {filters.map((item) => (
                  <GameplayIconAction
                    key={item.id}
                    label={`${item.label} ${filterCount(item.id)} groups`}
                    variant={filter === item.id ? "secondary" : "ghost"}
                    aria-pressed={filter === item.id}
                    disabled={busy}
                    onClick={() => {
                      setFilter(item.id);
                      setSavedSnapshot(null);
                      setSelectedId("");
                    }}
                  >
                    {item.icon}
                    <span>{filterCount(item.id)}</span>
                  </GameplayIconAction>
                ))}
              </div>
              <InstantVirtualList
                ariaLabel="OCR review crops"
                items={items}
                getItemId={workId}
                rowHeight={88}
                height={540}
                isFetching={list.isFetching}
                isFetchingNextPage={list.isFetchingNextPage}
                error={list.error}
                hasNextPage={list.hasNextPage}
                onEndReached={list.onEndReached}
                onRetry={() => {
                  void list.refetch();
                }}
                renderItem={(item) => (
                  <button
                    type="button"
                    className="gameplay-ai-crop-row"
                    aria-label={`Review ${item.region_id} in frame ${item.frame_id}`}
                    aria-pressed={groupKey === workId(item)}
                    disabled={busy && !preparing}
                    onClick={() => {
                      setSelectedId(workId(item));
                    }}
                  >
                    {item.crop_available !== false && item.crop_url ? (
                      <img src={mediaUrl(item.crop_url)} alt="" loading="lazy" />
                    ) : (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="gameplay-ai-thumbnail-unavailable"
                            aria-label="Crop unavailable"
                          >
                            <CircleHelp size={18} aria-hidden="true" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Crop unavailable</TooltipContent>
                      </Tooltip>
                    )}
                    <span>
                      <strong>{item.region_id}</strong>
                      <small>
                        {(item.conflicting_labels?.length || 0) > 1
                          ? item.conflicting_labels?.join(" / ")
                          : reviewed(item)
                            ? item.label || "∅"
                            : editableReading(item) || item.original_label || "∅"}
                      </small>
                    </span>
                    {(item.occurrence_count || 1) > 1 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="gameplay-ai-occurrence-count"
                            aria-label={`${item.occurrence_count} occurrences`}
                          >
                            ×{item.occurrence_count}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {item.occurrence_count} occurrences of this evidence
                        </TooltipContent>
                      </Tooltip>
                    )}
                    <Badge variant="outline">{stateLabel(item.state)}</Badge>
                  </button>
                )}
              />
            </section>
            <section className="gameplay-ai-inspector" aria-label="Crop inspector">
              {selected ? (
                <>
                  <div className="gameplay-ai-inspector-heading">
                    <strong>{selected.region_id}</strong>
                    <Badge variant="outline">{stateLabel(selected.state)}</Badge>
                    {selected.crop_scope === "legacy_source" && (
                      <Badge variant="secondary">Original legacy crop</Badge>
                    )}
                    {(selected.revision !== editingRevision.current ||
                      selected.id !== editingOccurrence.current) && (
                      <GameplayIconAction
                        label="Reload changed reading"
                        variant="ghost"
                        onClick={() => {
                          editingRevision.current = selected.revision;
                          editingOccurrence.current = selected.id;
                          setLabel(editableReading(selected));
                          setBlank(
                            selected.label === "" &&
                              ["unchanged", "corrected", "manual", "legacy_verified"].includes(
                                selected.state,
                              ),
                          );
                          setError("");
                        }}
                      >
                        <RefreshCw size={15} />
                      </GameplayIconAction>
                    )}
                  </div>
                  {(selectedGroup?.occurrence_count || 1) > 1 && (
                    <details
                      className="gameplay-ai-occurrences"
                      open={occurrencesOpen}
                      onToggle={(event) => {
                        setOccurrencesOpen(event.currentTarget.open);
                      }}
                    >
                      <summary>{selectedGroup?.occurrence_count} occurrences</summary>
                      <InstantVirtualList
                        ariaLabel="Evidence occurrences"
                        items={occurrences.items}
                        getItemId={itemId}
                        rowHeight={48}
                        height={Math.min(192, Math.max(48, occurrences.items.length * 48))}
                        isFetching={occurrences.isFetching}
                        isFetchingNextPage={occurrences.isFetchingNextPage}
                        error={occurrences.error}
                        hasNextPage={occurrences.hasNextPage}
                        onEndReached={occurrences.onEndReached}
                        onRetry={() => {
                          void occurrences.refetch();
                        }}
                        renderItem={(item) => (
                          <button
                            type="button"
                            className="gameplay-ai-occurrence-row"
                            aria-pressed={selected.id === item.id}
                            disabled={busy && !preparing}
                            onClick={() => {
                              setOccurrenceId(item.id);
                            }}
                          >
                            <span>
                              {item.region_id}
                              <small>Frame {item.frame_id}</small>
                            </span>
                            <span>
                              {item.label || "∅"}
                              <small>{stateLabel(item.state)}</small>
                            </span>
                          </button>
                        )}
                      />
                    </details>
                  )}
                  <div className="gameplay-ai-crop">
                    <GameplayReviewCrop item={selected} />
                  </div>
                  <div className="gameplay-ai-comparison">
                    <div>
                      <small>Original OCR</small>
                      <span>{selected.original_label || "∅"}</span>
                    </div>
                    <div>
                      <small>
                        {selected.proposed_text && !reviewed(selected)
                          ? "AI proposal · unverified"
                          : "Reviewed reading"}
                      </small>
                      <span>
                        {reviewed(selected) ? selected.label || "∅" : selected.proposed_text || "—"}
                      </span>
                    </div>
                  </div>
                  {selected.reason && <p className="gameplay-ai-reason">{selected.reason}</p>}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void save("manual");
                    }}
                  >
                    <Input
                      aria-label="Correct reading"
                      value={label}
                      disabled={busy || blank}
                      onChange={(event) => {
                        setLabel(event.target.value);
                      }}
                    />
                    {selected.category === "suit" && (
                      <div className="gameplay-ai-suits" role="group" aria-label="Card suit">
                        {suits.map((suit) => (
                          <GameplayIconAction
                            key={suit.value}
                            type="button"
                            label={`${suit.name} (${suit.value})`}
                            variant={!blank && label === suit.value ? "secondary" : "ghost"}
                            aria-pressed={!blank && label === suit.value}
                            disabled={busy}
                            onClick={() => {
                              setBlank(false);
                              setLabel(suit.value);
                            }}
                          >
                            <span aria-hidden="true" data-suit={suit.value}>
                              {suit.glyph}
                            </span>
                          </GameplayIconAction>
                        ))}
                      </div>
                    )}
                    <label className="gameplay-ai-blank">
                      <input
                        type="checkbox"
                        checked={blank}
                        disabled={busy}
                        onChange={(event) => {
                          setBlank(event.target.checked);
                        }}
                      />
                      Blank
                    </label>
                    <div className="gameplay-ai-inspector-actions">
                      <GameplayIconAction type="submit" label="Save and next" disabled={busy}>
                        <Check size={17} />
                      </GameplayIconAction>
                      <GameplayIconAction
                        type="button"
                        label="Mark ambiguous"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          void save("ambiguous");
                        }}
                      >
                        <CircleHelp size={17} />
                      </GameplayIconAction>
                      <GameplayIconAction
                        type="button"
                        label={context ? "Hide frame context" : "View frame context"}
                        variant="ghost"
                        onClick={() => {
                          setContext(!context);
                        }}
                      >
                        <Eye size={17} />
                      </GameplayIconAction>
                    </div>
                  </form>
                  {context && (
                    <img
                      className="gameplay-ai-frame-context"
                      src={mediaUrl(selected.image_url)}
                      alt={`Frame ${selected.frame_id}`}
                    />
                  )}
                </>
              ) : (
                <span className="gameplay-ai-empty">
                  {list.isFetching ? "Loading…" : "No crops"}
                </span>
              )}
            </section>
          </div>
        )}
      </section>
    </TooltipProvider>
  );
}
