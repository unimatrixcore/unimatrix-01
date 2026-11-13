import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, ToggleGroup, ToggleGroupItem } from "@unimatrix/ui/public";
import { NativeSelect } from "@unimatrix/ui/native-select";
import {
  Camera,
  Circle,
  Pause,
  Square,
  RefreshCw,
  Images,
  Layers,
  Radio,
  ArrowLeft,
} from "lucide-react";
import { RecordingPanel, RecordingSource } from "./recording_panel";
import { CaptureEmptyState } from "./capture_empty_state";
import { WorkspaceTopbar } from "./workspace_topbar";
import { RecordingTools } from "./recording_tools";
import { GameplayPreview } from "./gameplay_preview";
import type { GameplayPreviewFrame } from "./gameplay_preview";
import { CaptureListCard } from "./capture_list";
import {
  InstantVirtualGrid,
  InstantVirtualList,
  useBackgroundList,
  usePrefetchList,
} from "@unimatrix/instant-list";
import { Popover, PopoverContent, PopoverTrigger } from "@unimatrix/ui/popover";
import {
  pokerGameplaySessionSchema,
  pokerGameplayHandSchema,
  pokerGameplayFrameSummarySchema,
} from "@unimatrix/shared";
import { labListOptions, readLabListMeta } from "../lib/background-lists";
import { waitForViewport } from "../lib/viewport-ready";
import "./gameplay.css";

type Session = {
  id: string;
  name: string;
  source: string;
  interval_ms: number;
  status: string;
  created_at: string;
  frame_count: number;
  hand_count: number;
};
type Hand = { hand_id: string | null; frame_count: number; first_at: string; last_at: string };
type Frame = GameplayPreviewFrame & {
  session_id: string;
  ocr_status: string;
  error: string | null;
  thumbnail_url?: string;
  timings?: { total_ms: number; ocr_ms: number };
};
type Source = { name: string; label?: string; kind?: string };
type View = "recording" | "games" | "frames";
const handId = (item: Hand) => (item.hand_id === null ? "null" : `hand:${item.hand_id}`);
const frameId = (item: Frame) => item.id;
const parseHand = (value: unknown): Hand => pokerGameplayHandSchema.parse(value);
const parseFrame = (value: unknown): Frame => pokerGameplayFrameSummarySchema.parse(value) as Frame;
const parseSession = (value: unknown): Session => pokerGameplaySessionSchema.parse(value);
const sessionKey = (item: Session) => item.id;
const PREVIEW_INTERVAL_MS = 2000;
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch(
    `/api/gameplay${path}`,
    data === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    const error =
      result && typeof result === "object" && "error" in result && typeof result.error === "string"
        ? result.error
        : `Request failed (${response.status})`;
    throw new Error(error);
  }
  return result as T;
}

export interface GameplayProps {
  active: boolean;
  onLeave: React.MutableRefObject<() => Promise<void>>;
}

export function Gameplay({ active, onLeave }: GameplayProps) {
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [handPickerOpen, setHandPickerOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [initialFrameReady, setInitialFrameReady] = useState(false);
  const startupFinished = useRef(window.location.pathname !== "/gameplay");
  const activeRef = useRef(active);
  activeRef.current = active;
  const [view, setView] = useState<View>("recording");
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [interval, setIntervalMs] = useState(1000);

  const [hand, setHand] = useState<string | undefined>();
  const [latestFrame, setLatestFrame] = useState<Frame | null>(null);
  const [reviewFrame, setReviewFrame] = useState<Frame | null>(null);
  const [details, setDetails] = useState<Frame | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [revision, setRevision] = useState(0);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const initialSelection = useRef(false);
  const running = useRef(false);
  const inflight = useRef(false);
  const pendingCapture = useRef<Promise<void> | null>(null);
  const stopRequested = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const currentSession = useRef<Session | null>(null);
  const latest = useRef<Frame | null>(null);
  const previewAt = useRef(0);
  const acceptedEpoch = useRef(0);
  const actions = useRef({ capture: () => {}, toggle: () => {}, stop: () => {} });
  const visible = view === "recording" ? latestFrame : view === "frames" ? reviewFrame : null;
  const sessionOptions = labListOptions({
    path: "/api/gameplay",
    query: { archived: "0" },
    getItemId: sessionKey,
    parseItem: parseSession,
  });
  sessionOptions.queryKey = [...sessionOptions.queryKey, catalogRevision];
  const sessionList = useBackgroundList(sessionOptions);
  const sessionPrefetch = usePrefetchList(sessionOptions);
  const archivedOptions = labListOptions({
    path: "/api/gameplay",
    query: { archived: "1" },
    getItemId: sessionKey,
    parseItem: parseSession,
  });
  archivedOptions.queryKey = [...archivedOptions.queryKey, catalogRevision];
  const archivedPrefetch = usePrefetchList(archivedOptions);
  const gameOptions = labListOptions({
    path: `/api/gameplay/sessions/${sessionId}`,
    getItemId: handId,
    parseItem: parseHand,
    enabled: !!sessionId,
  });
  gameOptions.queryKey = [...gameOptions.queryKey, revision];
  const frameOptions = labListOptions({
    path: `/api/gameplay/sessions/${sessionId}/frames`,
    query: { order: "desc", ...(hand === undefined ? {} : { hand_id: hand }) },
    getItemId: frameId,
    parseItem: parseFrame,
    enabled: !!sessionId,
  });
  frameOptions.queryKey = [...frameOptions.queryKey, revision];
  const gameList = useBackgroundList({ ...gameOptions, enabled: !!sessionId });
  const frameList = useBackgroundList({
    ...frameOptions,
    enabled: !!sessionId && view === "frames",
  });
  const gamePrefetch = usePrefetchList(gameOptions);
  const framePrefetch = usePrefetchList(frameOptions);
  const games = gameList.items.filter((item) => item.hand_id);
  const hands = gameList.items;
  const frames = frameList.items;
  const total = readLabListMeta(frameList.data?.pages ?? [])?.total ?? frames.length;

  function pause() {
    running.current = false;
    clearTimeout(timer.current);
    setRecording(false);
    if (latest.current) setLatestFrame(latest.current);
  }
  useEffect(() => {
    const visibility = () => {
      setPageVisible(!document.hidden);
      // Capturing continues in the background, but decoding screenshots and
      // constructing overlays serves no purpose until the app is visible.
      if (!document.hidden && latest.current) {
        previewAt.current = performance.now();
        setLatestFrame(latest.current);
      }
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  function selectSession(id: string, selected = sessionList.items.find((item) => item.id === id)) {
    pause();
    stopRequested.current = false;
    ++acceptedEpoch.current;
    currentSession.current = selected || null;
    latest.current = null;
    setSessionId(id);
    setSession(selected || null);
    setLatestFrame(null);
    setReviewFrame(null);
    setDetails(null);
    setHand(undefined);
    setError("");
    setSkipReason("");
    if (selected) {
      setSource(selected.source);
      setIntervalMs(selected.interval_ms);
    }
  }
  async function refreshSources() {
    try {
      const result = await api<{ sources: Source[] }>("/sources");
      if (!alive.current) return;
      setSources(result.sources);
      setSource((old) =>
        result.sources.some((item) => item.name === old) ? old : result.sources[0]?.name || "",
      );
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    }
  }
  useEffect(() => {
    alive.current = true;
    void refreshSources();
    const leave = () => {
      running.current = false;
      stopRequested.current = true;
      clearTimeout(timer.current);
      const current = currentSession.current;
      if (current && current.status !== "stopped")
        navigator.sendBeacon(
          `/api/gameplay/sessions/${current.id}/stop`,
          new Blob(["{}"], { type: "application/json" }),
        );
    };
    window.addEventListener("pagehide", leave);
    return () => {
      alive.current = false;
      leave();
      window.removeEventListener("pagehide", leave);
    };
  }, []);

  useEffect(() => {
    if (!initialSelection.current && sessionList.isSuccess) {
      initialSelection.current = true;
      if (!currentSession.current && sessionList.items[0])
        selectSession(sessionList.items[0].id, sessionList.items[0]);
    }
  }, [sessionList.items, sessionId]);

  useEffect(() => {
    if (!active || startupFinished.current) return;
    const timer = setTimeout(() => {
      if (startupFinished.current || !activeRef.current) return;
      startupFinished.current = true;
      setError("Loading the first view timed out. Retry the recordings list.");
      document.getElementById("loading-overlay")?.classList.remove("active");
    }, 10000);
    return () => {
      clearTimeout(timer);
    };
  }, [active]);
  useEffect(() => {
    if (
      !active ||
      startupFinished.current ||
      (!sessionList.isError &&
        (!sessionList.isSuccess ||
          (sessionList.items.length > 0 && (!sessionId || !initialFrameReady))))
    )
      return;
    const controller = new AbortController();
    const host = document.querySelector<HTMLElement>(".gameplay-workspace");
    if (host)
      void waitForViewport(host, controller.signal).then((ready) => {
        if (controller.signal.aborted || startupFinished.current) return;
        startupFinished.current = true;
        if (!ready) setError("Loading the first view timed out. Retry the recordings list.");
        document.getElementById("loading-overlay")?.classList.remove("active");
      });
    return () => {
      controller.abort();
    };
  }, [
    active,
    sessionList.isError,
    sessionList.isSuccess,
    sessionList.items.length,
    sessionId,
    initialFrameReady,
  ]);

  // Load a saved session once. A completed capture already contains its new
  // session summary; recording must not refetch history on every frame.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const epoch = acceptedEpoch.current;
    Promise.all([
      api<{ frames: Frame[] }>(`/sessions/${sessionId}/frames?order=desc&limit=1&offset=0`),
    ])
      .then(([page]) => {
        if (cancelled || epoch !== acceptedEpoch.current) return;
        if (page.frames[0]) {
          latest.current = page.frames[0];
          setLatestFrame(page.frames[0]);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setInitialFrameReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Only the displayed frame needs region readings. Metadata pages and captures
  // stay small; a late response can never annotate a different screenshot.
  useEffect(() => {
    if (!visible) {
      setDetails(null);
      return;
    }
    if (!pageVisible) return;
    let cancelled = false;
    api<{ frame: Frame }>(`/frames/${visible.id}`)
      .then((result) => {
        if (!cancelled) setDetails(result.frame);
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [visible?.id, pageVisible]);

  function capture(): Promise<void> {
    if (pendingCapture.current) return pendingCapture.current;
    const pending = runCapture().finally(() => {
      pendingCapture.current = null;
    });
    pendingCapture.current = pending;
    return pending;
  }
  async function runCapture() {
    if (
      stopRequested.current ||
      inflight.current ||
      !source ||
      currentSession.current?.status === "stopped"
    )
      return;
    inflight.current = true;
    setBusy(true);
    setError("");
    setSkipReason("");
    try {
      let current = currentSession.current;
      if (!current) {
        const result = await api<{ session: Session }>("/sessions", {
          source,
          interval_ms: interval,
          name: name.trim() || undefined,
        });
        current = result.session;
        currentSession.current = current;
        if (!alive.current) {
          await api(`/sessions/${current.id}/stop`, {});
          currentSession.current = { ...current, status: "stopped" };
          if (alive.current) {
            setSession(currentSession.current);
            setSessionId(current.id);
          }
          return;
        }
        if (alive.current) {
          setSession(current);
          setSessionId(current.id);
          setCatalogRevision((value) => value + 1);
        }
        if (stopRequested.current) return;
      }
      const result = await api<{
        frame?: Frame;
        session?: Session;
        skipped?: boolean;
        reason?: string;
      }>(`/sessions/${current.id}/capture`, {});
      if (!alive.current || stopRequested.current) return;
      if (result.skipped || !result.frame) {
        setSkipReason(result.reason || "Waiting for a readable poker table.");
        return;
      }
      ++acceptedEpoch.current;
      latest.current = result.frame;
      if (
        !document.hidden &&
        (!previewAt.current ||
          performance.now() - previewAt.current >= PREVIEW_INTERVAL_MS ||
          !running.current)
      ) {
        previewAt.current = performance.now();
        setLatestFrame(result.frame);
      }
      const saved = result.session || { ...current, frame_count: current.frame_count + 1 };
      currentSession.current = saved;
      setSession(saved);
    } catch (error) {
      if (alive.current && !stopRequested.current) {
        pause();
        setError(errorMessage(error));
      }
    } finally {
      inflight.current = false;
      if (alive.current) {
        setBusy(false);
        if (running.current)
          timer.current = setTimeout(
            () => void capture(),
            currentSession.current?.interval_ms || interval,
          );
      }
    }
  }
  function toggle() {
    if (stopRequested.current) return;
    if (running.current) {
      pause();
      return;
    }
    if (!source || inflight.current || currentSession.current?.status === "stopped") return;
    running.current = true;
    setRecording(true);
    void capture();
  }
  async function stop(propagate = false) {
    pause();
    stopRequested.current = inflight.current || currentSession.current !== null;
    await pendingCapture.current;
    const current = currentSession.current;
    if (!current || current.status === "stopped") return;
    setBusy(true);
    try {
      const result = await api<{ session: Session }>(`/sessions/${current.id}/stop`, {});
      currentSession.current = result.session;
      if (alive.current) setSession(result.session);
    } catch (error) {
      stopRequested.current = false;
      if (alive.current) setError(errorMessage(error));
      if (propagate) throw error;
    } finally {
      if (alive.current && !inflight.current) setBusy(false);
    }
  }
  onLeave.current = () => stop(true);
  actions.current = { capture: () => void capture(), toggle, stop: () => void stop() };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !activeRef.current ||
        event.defaultPrevented ||
        document.querySelector(
          '[data-recording-source-open="true"], [data-slot=popover-content][data-state=open]',
        ) ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,select,button,summary,a,[contenteditable="true"]'))
      )
        return;
      if (event.code === "Space" || event.code === "KeyC") {
        event.preventDefault();
        actions.current.capture();
      } else if (event.code === "KeyW") {
        event.preventDefault();
        actions.current.toggle();
      } else if (event.code === "Escape") {
        event.preventDefault();
        actions.current.stop();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);

  async function manageRecording(id: string, action: "rename" | "archive" | "restore", data = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ session: Session }>(`/sessions/${id}/${action}`, data);
      if (!alive.current) return;
      if (action === "archive") {
        setCatalogRevision((value) => value + 1);
        selectSession("");
      } else {
        setCatalogRevision((value) => value + 1);
        if (action === "restore") selectSession(id, result.session);
        else {
          setSession(result.session);
          currentSession.current = result.session;
        }
      }
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
      throw error;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const stopped = session?.status === "stopped";
  const locked = !!session || busy || recording;
  // Keep a fully annotated live frame on screen while the next frame's
  // readings arrive, instead of flashing an image with empty state between them.
  const shown =
    visible && details && (details.id === visible.id || view === "recording") ? details : visible;

  return (
    <section className="gameplay-workspace" aria-label="Gameplay recordings">
      <WorkspaceTopbar
        className="gameplay-topbar"
        ariaLabel="Gameplay navigation"
        leading={
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value) {
                setView(value as View);
                setReviewFrame(null);
              }
            }}
            size="sm"
            spacing={1}
            aria-label="Gameplay views"
          >
            <ToggleGroupItem
              value="recording"
              className="dataset-icon"
              aria-label="Recording view"
              title="Recording"
            >
              <Radio size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem
              {...gamePrefetch}
              value="games"
              className="dataset-icon"
              aria-label="Games view"
              title={`Games · ${session?.hand_count || 0}`}
            >
              <Layers size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem
              {...framePrefetch}
              value="frames"
              className="dataset-icon"
              aria-label="Frames view"
              title={`Frames · ${session?.frame_count || 0}`}
            >
              <Images size={16} />
            </ToggleGroupItem>
          </ToggleGroup>
        }
        actions={
          <>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Recording session"
                  disabled={busy || recording}
                  {...sessionPrefetch}
                >
                  {session?.name || "New recording"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="recording-settings-popover" align="end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    selectSession("");
                    setPickerOpen(false);
                  }}
                >
                  New recording
                </Button>
                <InstantVirtualList
                  ariaLabel="Recording sessions"
                  items={sessionList.items}
                  getItemId={sessionKey}
                  rowHeight={40}
                  height={240}
                  isFetching={sessionList.isFetching}
                  error={sessionList.error}
                  hasNextPage={sessionList.hasNextPage}
                  onEndReached={sessionList.onEndReached}
                  onRetry={() => {
                    void sessionList.refetch();
                  }}
                  renderItem={(item) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        selectSession(item.id, item);
                        setPickerOpen(false);
                      }}
                    >
                      {item.name} · {item.frame_count} frames
                    </Button>
                  )}
                />
              </PopoverContent>
            </Popover>
            {view === "frames" && (
              <>
                <Popover open={handPickerOpen} onOpenChange={setHandPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Recorded hand"
                      {...gamePrefetch}
                    >
                      {hand === undefined
                        ? "All frames"
                        : hand === ""
                          ? "Unassigned"
                          : `Hand #${hand}`}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="recording-settings-popover" align="end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setHand(undefined);
                        setReviewFrame(null);
                        setHandPickerOpen(false);
                      }}
                    >
                      All frames
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setHand("");
                        setReviewFrame(null);
                        setHandPickerOpen(false);
                      }}
                    >
                      Unassigned
                    </Button>
                    <InstantVirtualList
                      ariaLabel="Recorded hands"
                      items={hands}
                      getItemId={handId}
                      rowHeight={40}
                      height={200}
                      isFetching={gameList.isFetching}
                      error={gameList.error}
                      hasNextPage={gameList.hasNextPage}
                      onEndReached={gameList.onEndReached}
                      onRetry={() => {
                        void gameList.refetch();
                      }}
                      renderItem={(item) => (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setHand(item.hand_id ?? "");
                            setReviewFrame(null);
                            setHandPickerOpen(false);
                          }}
                        >
                          Hand #{item.hand_id} · {item.frame_count}
                        </Button>
                      )}
                    />
                  </PopoverContent>
                </Popover>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="dataset-icon"
                  aria-label="Refresh frames"
                  title="Refresh frames"
                  onClick={() => {
                    setRevision((value) => value + 1);
                  }}
                >
                  <RefreshCw size={16} />
                </Button>
              </>
            )}
            {view === "games" && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="dataset-icon"
                aria-label="Refresh games"
                title="Refresh games"
                onClick={() => {
                  setRevision((value) => value + 1);
                }}
              >
                <RefreshCw size={16} />
              </Button>
            )}
            <RecordingTools
              current={session}
              disabled={busy || recording}
              onNew={() => {
                selectSession("");
              }}
              onRename={(name) => manageRecording(sessionId, "rename", { name })}
              onArchive={() => manageRecording(sessionId, "archive")}
              onRestore={(id) => manageRecording(id, "restore")}
              archivedOptions={archivedOptions}
              archivedPrefetch={archivedPrefetch}
            />
          </>
        }
      />
      {error && (
        <div className="gameplay-error" role="alert">
          {error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
            }}
            aria-label="Dismiss error"
          >
            ×
          </Button>
        </div>
      )}
      {view === "recording" ? (
        shown ? (
          <GameplayPreview frame={shown} isLive={recording} />
        ) : (
          <CaptureEmptyState
            title="Waiting for a valid frame"
            description="Choose a source, then capture once or start recording. Only valid poker-table frames are saved."
          />
        )
      ) : view === "games" ? (
        <section className="gameplay-games-view" aria-label="Saved games">
          <div className="gameplay-frames-heading">
            <h2>Games</h2>
            <Badge variant="outline">{games.length} saved</Badge>
          </div>
          {!games.length && !gameList.isFetching && !gameList.error ? (
            <CaptureEmptyState
              title="No saved games"
              description="Recorded games appear here, grouped by game ID. Switch to Recording to capture a poker table."
            />
          ) : (
            <InstantVirtualGrid
              ariaLabel="Recorded games"
              items={games}
              getItemId={handId}
              rowHeight={110}
              minColumnWidth={220}
              height="min(65vh, 650px)"
              isFetching={gameList.isFetching}
              error={gameList.error}
              hasNextPage={gameList.hasNextPage}
              onEndReached={gameList.onEndReached}
              onRetry={() => {
                void gameList.refetch();
              }}
              renderItem={(item) => (
                <CaptureListCard
                  className="gameplay-game-card"
                  label={`Game #${item.hand_id}`}
                  id={`${item.frame_count} ${item.frame_count === 1 ? "frame" : "frames"}`}
                  secondaryText={`${time(item.first_at)}–${time(item.last_at)}`}
                  openLabel={`Open game ${item.hand_id}`}
                  onOpen={() => {
                    setHand(item.hand_id!);
                    setReviewFrame(null);
                    setView("frames");
                  }}
                />
              )}
            />
          )}
        </section>
      ) : reviewFrame && shown ? (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to frames"
            title="Back to frames"
            onClick={() => {
              setReviewFrame(null);
            }}
          >
            <ArrowLeft size={16} />
          </Button>
          <GameplayPreview frame={shown} />
        </>
      ) : (
        <section className="gameplay-frames-view" aria-label="Saved frames">
          <div className="gameplay-frames-heading">
            <h2>Frames</h2>
            <Badge variant="outline">{total} saved</Badge>
          </div>
          {!frames.length && !frameList.isFetching && !frameList.error ? (
            <CaptureEmptyState
              title="No saved frames"
              description="Valid captures appear here. Switch to Recording to capture a poker table."
            />
          ) : (
            <InstantVirtualGrid
              ariaLabel="Recorded frames"
              items={frames}
              getItemId={frameId}
              rowHeight={200}
              minColumnWidth={220}
              height="min(65vh, 650px)"
              isFetching={frameList.isFetching}
              error={frameList.error}
              hasNextPage={frameList.hasNextPage}
              onEndReached={frameList.onEndReached}
              onRetry={() => {
                void frameList.refetch();
              }}
              renderItem={(item) => (
                <CaptureListCard
                  className="gameplay-frame-card"
                  imageSrc={item.thumbnail_url || item.preview_url || item.image_url}
                  alt={`Game #${item.hand_id} captured at ${time(item.captured_at)}`}
                  label={time(item.captured_at)}
                  id={`Game #${item.hand_id}`}
                  openLabel={`Inspect frame ${time(item.captured_at)}`}
                  onOpen={() => {
                    setReviewFrame(item);
                  }}
                />
              )}
            />
          )}
        </section>
      )}
      <RecordingPanel
        className="gameplay-recording-panel"
        ariaLabel="Gameplay recording controls"
        status={
          recording
            ? "Recording"
            : busy
              ? "Capturing…"
              : stopped
                ? "Stopped"
                : session
                  ? "Paused"
                  : "Ready"
        }
        state={recording ? "watching" : busy ? "busy" : stopped || session ? "paused" : "ready"}
        detail={
          skipReason || `${session?.frame_count || 0} frames · ${session?.hand_count || 0} hands`
        }
        source={
          <RecordingSource
            label={sources.find((item) => item.name === source)?.label || source || "Choose source"}
          >
            <div className="capture-source-heading">
              <strong>Capture source</strong>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={locked}
                onClick={() => void refreshSources()}
                aria-label="Refresh capture sources"
                title="Refresh monitors and windows"
              >
                <RefreshCw size={16} />
              </Button>
            </div>
            <div className="monitor-control">
              <NativeSelect
                aria-label="Capture source"
                size="sm"
                className="w-full"
                value={source}
                disabled={locked}
                onChange={(event) => {
                  setSource(event.target.value);
                }}
              >
                <option value="" disabled>
                  Choose source
                </option>
                {sources.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.label || item.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <label className="monitor-control">
              Recording name
              <Input
                placeholder="Gameplay session"
                value={session?.name || name}
                disabled={locked}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </label>
            <div className="watch-settings-fields">
              <label>
                Check every
                <NativeSelect
                  size="sm"
                  value={interval}
                  disabled={locked}
                  onChange={(event) => {
                    setIntervalMs(Number(event.target.value));
                  }}
                >
                  <option value={1000}>1 second</option>
                  <option value={2000}>2 seconds</option>
                  <option value={5000}>5 seconds</option>
                </NativeSelect>
              </label>
            </div>
          </RecordingSource>
        }
        capture={
          <Button
            variant="outline"
            disabled={busy || recording || !source || stopped}
            onClick={() => void capture()}
          >
            <Camera size={16} />
            Capture
          </Button>
        }
        record={
          <div className="record-toggle-slot">
            <Button disabled={!source || stopped || (busy && !recording)} onClick={toggle}>
              {recording ? <Pause size={16} /> : <Circle size={16} />}{" "}
              {recording ? "Pause" : "Record"}
            </Button>
          </div>
        }
        stop={
          session && !stopped ? (
            <Button variant="outline" onClick={() => void stop()}>
              <Square size={16} />
              Stop
            </Button>
          ) : undefined
        }
      />
    </section>
  );
}
