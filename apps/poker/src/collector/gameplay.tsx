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
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { RecordingPanel, RecordingSource } from "./recording_panel";
import { CaptureEmptyState } from "./capture_empty_state";
import { WorkspaceTopbar } from "./workspace_topbar";
import { RecordingTools } from "./recording_tools";
import { GameplayPreview } from "./gameplay_preview";
import type { GameplayPreviewFrame } from "./gameplay_preview";
import { CaptureList, CaptureListCard } from "./capture_list";
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
const PAGE_SIZE = 12;
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

export function Gameplay() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [view, setView] = useState<View>("recording");
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [interval, setIntervalMs] = useState(1000);
  const [hands, setHands] = useState<Hand[]>([]);
  const [hand, setHand] = useState<string | undefined>();
  const [frames, setFrames] = useState<Frame[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [gameOffset, setGameOffset] = useState(0);
  const [latestFrame, setLatestFrame] = useState<Frame | null>(null);
  const [reviewFrame, setReviewFrame] = useState<Frame | null>(null);
  const [details, setDetails] = useState<Frame | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [skipReason, setSkipReason] = useState("");
  const [revision, setRevision] = useState(0);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const running = useRef(false);
  const inflight = useRef(false);
  const stopRequested = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const currentSession = useRef<Session | null>(null);
  const latest = useRef<Frame | null>(null);
  const previewAt = useRef(0);
  const acceptedEpoch = useRef(0);
  const actions = useRef({ capture: () => {}, toggle: () => {}, stop: () => {} });
  const visible = view === "recording" ? latestFrame : view === "frames" ? reviewFrame : null;
  const games = hands
    .filter((item) => item.hand_id !== null && item.hand_id !== "")
    .slice()
    .reverse();
  const gamePage = games.slice(gameOffset, gameOffset + PAGE_SIZE);

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
  function selectSession(id: string, selected = sessions.find((item) => item.id === id)) {
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
    setFrames([]);
    setTotal(0);
    setHands([]);
    setHand(undefined);
    setOffset(0);
    setGameOffset(0);
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
    api<{ sessions: Session[] }>("")
      .then((result) => {
        if (!alive.current) return;
        setSessions(result.sessions);
        const first = result.sessions[0];
        if (!currentSession.current && first) selectSession(first.id, first);
      })
      .catch((error) => {
        if (alive.current) setError(errorMessage(error));
      });
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

  // Load a saved session once. A completed capture already contains its new
  // session summary; recording must not refetch history on every frame.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const epoch = acceptedEpoch.current;
    Promise.all([
      api<{ session: Session; hands: Hand[] }>(`/sessions/${sessionId}`),
      api<{ frames: Frame[] }>(`/sessions/${sessionId}/frames?order=desc&limit=1&offset=0`),
    ])
      .then(([metadata, page]) => {
        if (cancelled || epoch !== acceptedEpoch.current) return;
        setSession(metadata.session);
        currentSession.current = metadata.session;
        setHands(metadata.hands);
        if (page.frames[0]) {
          latest.current = page.frames[0];
          setLatestFrame(page.frames[0]);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // The Frames view is a stable, explicitly refreshed page, independent of the
  // recording feed. New captures never move the user's selected hand or page.
  useEffect(() => {
    if (view !== "frames" || !sessionId) return;
    let cancelled = false;
    const query = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE_SIZE),
      order: "desc",
    });
    if (hand !== undefined) query.set("hand_id", hand);
    api<{ frames: Frame[]; total: number }>(`/sessions/${sessionId}/frames?${query}`)
      .then((result) => {
        if (!cancelled) {
          setFrames(result.frames);
          setTotal(result.total);
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [view, sessionId, hand, offset, revision]);

  // Games use the existing hand summaries; no screenshot/details per game.
  useEffect(() => {
    if (!sessionId || !revision) return;
    let cancelled = false;
    const epoch = acceptedEpoch.current;
    api<{ session: Session; hands: Hand[] }>(`/sessions/${sessionId}`)
      .then((result) => {
        if (cancelled || epoch !== acceptedEpoch.current) return;
        setHands(result.hands);
        setSession(result.session);
        currentSession.current = result.session;
      })
      .catch((error) => {
        if (!cancelled) setError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

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

  async function capture() {
    if (inflight.current || !source || currentSession.current?.status === "stopped") return;
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
        if (!alive.current || stopRequested.current) {
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
          setSessions((old) => [current!, ...old.filter((item) => item.id !== current!.id)]);
        }
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
      setSessions((old) => [saved, ...old.filter((item) => item.id !== saved.id)]);
      const captured = result.frame;
      setHands((old) => {
        const known = old.find((item) => item.hand_id === captured.hand_id);
        return known
          ? old.map((item) =>
              item === known
                ? { ...item, frame_count: item.frame_count + 1, last_at: captured.captured_at }
                : item,
            )
          : [
              ...old,
              {
                hand_id: captured.hand_id,
                frame_count: 1,
                first_at: captured.captured_at,
                last_at: captured.captured_at,
              },
            ];
      });
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
    if (running.current) {
      pause();
      return;
    }
    if (!source || inflight.current || currentSession.current?.status === "stopped") return;
    running.current = true;
    setRecording(true);
    void capture();
  }
  async function stop() {
    pause();
    stopRequested.current = inflight.current || currentSession.current !== null;
    const current = currentSession.current;
    if (!current || current.status === "stopped") return;
    setBusy(true);
    try {
      const result = await api<{ session: Session }>(`/sessions/${current.id}/stop`, {});
      currentSession.current = result.session;
      if (alive.current) setSession(result.session);
    } catch (error) {
      if (alive.current) setError(errorMessage(error));
    } finally {
      if (alive.current && !inflight.current) setBusy(false);
    }
  }
  actions.current = { capture: () => void capture(), toggle, stop: () => void stop() };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
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
        setSessions((old) => old.filter((item) => item.id !== id));
        selectSession("");
      } else {
        setSessions((old) => [result.session, ...old.filter((item) => item.id !== id)]);
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
              value="games"
              className="dataset-icon"
              aria-label="Games view"
              title={`Games · ${session?.hand_count || 0}`}
            >
              <Layers size={16} />
            </ToggleGroupItem>
            <ToggleGroupItem
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
            <NativeSelect
              size="sm"
              aria-label="Recording session"
              title="Recording session"
              value={sessionId}
              disabled={busy || recording}
              onChange={(event) => {
                selectSession(event.target.value);
              }}
            >
              <option value="">New recording</option>
              {sessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.frame_count} {item.frame_count === 1 ? "frame" : "frames"}
                </option>
              ))}
            </NativeSelect>
            {view === "frames" && (
              <>
                <NativeSelect
                  size="sm"
                  aria-label="Recorded hand"
                  title="Recorded hand"
                  value={hand ?? "all"}
                  onChange={(event) => {
                    setHand(event.target.value === "all" ? undefined : event.target.value);
                    setOffset(0);
                    setReviewFrame(null);
                  }}
                >
                  <option value="all">All frames</option>
                  {hands.map((item) => (
                    <option key={item.hand_id ?? "unassigned"} value={item.hand_id || ""}>
                      Hand #{item.hand_id} · {item.frame_count}
                    </option>
                  ))}
                </NativeSelect>
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
              loadArchived={async () =>
                (await api<{ sessions: Session[] }>("?archived=1")).sessions
              }
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
          {!games.length ? (
            <CaptureEmptyState
              title="No saved games"
              description="Recorded games appear here, grouped by game ID. Switch to Recording to capture a poker table."
            />
          ) : (
            <CaptureList label="Recorded games">
              {gamePage.map((item) => (
                <CaptureListCard
                  key={item.hand_id}
                  className="gameplay-game-card"
                  label={`Game #${item.hand_id}`}
                  id={`${item.frame_count} ${item.frame_count === 1 ? "frame" : "frames"}`}
                  secondaryText={`${time(item.first_at)}–${time(item.last_at)}`}
                  openLabel={`Open game ${item.hand_id}`}
                  onOpen={() => {
                    setHand(item.hand_id!);
                    setOffset(0);
                    setReviewFrame(null);
                    setView("frames");
                  }}
                />
              ))}
            </CaptureList>
          )}
          {games.length > PAGE_SIZE && (
            <div className="gameplay-pagination">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous game page"
                title="Previous page"
                disabled={!gameOffset}
                onClick={() => {
                  setGameOffset((value) => Math.max(0, value - PAGE_SIZE));
                }}
              >
                <ChevronLeft size={16} />
              </Button>
              <span>
                {gameOffset + 1}–{Math.min(games.length, gameOffset + PAGE_SIZE)} of {games.length}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next game page"
                title="Next page"
                disabled={gameOffset + PAGE_SIZE >= games.length}
                onClick={() => {
                  setGameOffset((value) => value + PAGE_SIZE);
                }}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
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
          {!frames.length ? (
            <CaptureEmptyState
              title="No saved frames"
              description="Valid captures appear here. Switch to Recording to capture a poker table."
            />
          ) : (
            <CaptureList label="Recorded frames">
              {frames.map((item) => (
                <CaptureListCard
                  key={item.id}
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
              ))}
            </CaptureList>
          )}
          {total > PAGE_SIZE && (
            <div className="gameplay-pagination">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Previous frame page"
                title="Previous page"
                disabled={!offset}
                onClick={() => {
                  setOffset((value) => Math.max(0, value - PAGE_SIZE));
                  setReviewFrame(null);
                }}
              >
                <ChevronLeft size={16} />
              </Button>
              <span>
                {offset + 1}–{Math.min(total, offset + PAGE_SIZE)} of {total}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Next frame page"
                title="Next page"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => {
                  setOffset((value) => value + PAGE_SIZE);
                  setReviewFrame(null);
                }}
              >
                <ChevronRight size={16} />
              </Button>
            </div>
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
