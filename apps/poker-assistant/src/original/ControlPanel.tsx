import type {
  PokerAssistantMonitor as MonitorInfo,
  PokerAssistantCrop as CroppedRegion,
  PokerProductionState as ProductionRead,
  PokerProductionCapture as ProductionCapture,
} from "@unimatrix/shared";
import { useState, useEffect, useRef } from "react";
import { invoke } from "./invoke.js";
import { usePokerStore, type PokerState } from "./store.js";
import { Button, Input, NativeSelect } from "@unimatrix/ui";
import { Club, Diamond, Heart, Spade } from "lucide-react";

const Card = ({ card, size = "md" }: { card: string | null; size?: "sm" | "md" }) => {
  const { colors } = usePokerStore();

  if (!card || !colors) {
    return (
      <div
        className={
          size === "sm"
            ? "w-6 h-8 rounded border border-slate-800 bg-slate-900/50 border-dashed"
            : "w-12 h-16 rounded border border-slate-800 bg-slate-900/50 border-dashed flex items-center justify-center text-slate-700 font-bold text-sm"
        }
      >
        {size === "md" && "?"}
      </div>
    );
  }

  const isDimmed = card.endsWith("_");
  const cleanCard = isDimmed ? card.slice(0, -1) : card;
  const rank = cleanCard.slice(0, -1);
  const suitLetter = cleanCard.slice(-1).toLowerCase();

  const suitKey = {
    d: "diamonds",
    s: "spades",
    c: "clubs",
    h: "hearts",
  }[suitLetter as "d" | "s" | "c" | "h"];

  const color = suitKey
    ? isDimmed
      ? colors.dim_suits[suitKey as keyof typeof colors.dim_suits]
      : colors.suits[suitKey as keyof typeof colors.suits]
    : "#ffffff";

  const textColor = isDimmed ? colors.dim_text : colors.card_text;

  const SuitIcon = {
    d: Diamond,
    s: Spade,
    c: Club,
    h: Heart,
  }[suitLetter as "d" | "s" | "c" | "h"];

  if (size === "sm") {
    return (
      <div
        className="flex items-center justify-center px-1 rounded-[2px] font-bold text-[9px] shadow-sm border border-black/20"
        style={{ backgroundColor: color, color: textColor }}
      >
        <span>{rank}</span>
        {SuitIcon && <SuitIcon size={8} fill={textColor} stroke={textColor} className="ml-0.5" />}
      </div>
    );
  }

  return (
    <div
      className="w-12 h-16 rounded shadow-md border border-black/20 flex flex-col items-center justify-center relative overflow-hidden"
      style={{ backgroundColor: color, color: textColor }}
    >
      <span className="text-sm font-black leading-none mb-1">{rank}</span>
      {SuitIcon && <SuitIcon size={20} fill={textColor} stroke={textColor} strokeWidth={1.5} />}

      {/* Corner indicators */}
      <div className="absolute top-0.5 left-1 text-[8px] font-bold">{rank}</div>
      <div className="absolute bottom-0.5 right-1 text-[8px] font-bold rotate-180">{rank}</div>

      {isDimmed && <div className="absolute inset-0 bg-black/10 pointer-events-none" />}
    </div>
  );
};

export default function ControlPanel() {
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [debugImage, setDebugImage] = useState<string | null>(null);
  const [regions, setRegions] = useState<CroppedRegion[]>([]);
  const [showOverlay, setShowOverlay] = useState(true);
  const [imgDims, setImgDims] = useState({ w: 1920, h: 1080 });
  const [captureStatus, setCaptureStatus] = useState<string>("Idle");
  const [envInfo, setEnvInfo] = useState<string | null>(null);
  const [readAge, setReadAge] = useState<number | null>(null);
  const generation = useRef(0);
  const captureBusy = useRef(false);
  const captureFault = useRef(false);
  const expiryTimer = useRef<number | undefined>(undefined);
  const previewUrl = useRef<string | null>(null);
  const lifecycle = useRef<Promise<void>>(Promise.resolve());
  const inFlightCapture = useRef<Promise<void>>(Promise.resolve());
  const inFlightPoll = useRef<Promise<void>>(Promise.resolve());

  const {
    selectedMonitorIndex,
    setSelectedMonitorIndex,
    isRunning,
    setIsRunning,
    clearGameState,
    username,
    setUsername,
    debugInfo,
    setDebugInfo,
    setColors,
  } = usePokerStore();

  const fetchMonitors = async () => {
    try {
      const [m, c] = await Promise.all([
        invoke<MonitorInfo[]>("get_monitors"),
        invoke<PokerState["colors"]>("get_colors"),
      ]);
      setMonitors(m);
      setColors(c);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void fetchMonitors();
  }, []);

  const applyRead = (result: ProductionRead, epoch: number, requestElapsed = 0) => {
    if (generation.current !== epoch) return;
    window.clearTimeout(expiryTimer.current);
    const age = result.capture_age_ms === null ? null : result.capture_age_ms + requestElapsed;
    // The backend expires reads from their capture time. Receipt is not a new
    // observation, and unknown data must replace every previous display field.
    if (
      result.state !== "available" ||
      !result.game_state ||
      age === null ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 1000
    ) {
      clearGameState();
      setReadAge(null);
      setCaptureStatus(
        result.reason === "stale" ? "Waiting for a fresh read" : "Waiting for confirmed game state",
      );
      return;
    }
    const state = result.game_state;
    setDebugInfo({
      inPlaySeats: state.in_play_seats,
      seatUsernames: state.seat_usernames,
      seatCards: state.seat_cards,
      seatBets: state.seat_bets,
      seatBanks: state.seat_banks,
      seatStatuses: state.seat_statuses,
      seatDealers: state.seat_dealers,
      pot: state.pot,
      splitPot: state.split_pot,
      activeSeat: state.active_seat,
      activeSeatColor: state.active_seat_color,
      mySeatIndex: state.my_seat_index,
      communityCards: state.community_cards,
      gameId: state.game_id,
    });
    setReadAge(age);
    setCaptureStatus("Reading confirmed game state");
    // Expire locally even if a later IPC request stalls or the backend exits.
    expiryTimer.current = window.setTimeout(
      () => {
        if (generation.current !== epoch) return;
        clearGameState();
        setReadAge(null);
        setCaptureStatus("Waiting for a fresh read");
      },
      Math.max(0, 1000 - age),
    );
  };

  const showCapture = (bytes: number[]) => {
    if (!bytes.length) throw new Error("Capture returned no pixels");
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: "image/png" }),
    );
    setDebugImage(previewUrl.current);
  };

  const handleCapture = async () => {
    if (selectedMonitorIndex === null || isRunning || captureBusy.current) return;
    const epoch = generation.current;
    captureBusy.current = true;
    const work = (async () => {
      await lifecycle.current;
      if (generation.current !== epoch) return;
      setError(null);
      try {
        setCaptureStatus("Capturing preview...");
        const captured = await invoke<ProductionCapture>("capture_production_frame", {
          monitorIndex: selectedMonitorIndex,
        });
        if (generation.current !== epoch) return;
        showCapture(captured.screenshot_bytes);
        const extracted = await invoke<CroppedRegion[]>("extract_regions", {
          screenshotBytes: captured.screenshot_bytes,
        });
        if (generation.current !== epoch) return;
        setRegions(extracted);
        // A single preview is not enough to confirm a new game. Keep polling
        // until its freshness window ends instead of fabricating game state.
        const until = performance.now() + 1100;
        while (generation.current === epoch && performance.now() < until) {
          const requestStarted = performance.now();
          const result = await invoke<ProductionRead>("get_production_state", {
            username: usePokerStore.getState().username,
          });
          applyRead(result, epoch, performance.now() - requestStarted);
          await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        if (generation.current === epoch) {
          clearGameState();
          setReadAge(null);
          setCaptureStatus("Preview captured; start the assistant for confirmed reads");
        }
      } catch (err) {
        if (generation.current === epoch) {
          clearGameState();
          setReadAge(null);
          setError(String(err));
          setCaptureStatus("Read unavailable");
        }
      }
    })();
    inFlightCapture.current = work;
    try {
      await work;
    } finally {
      captureBusy.current = false;
    }
  };

  const handleSaveDebug = async () => {
    if (selectedMonitorIndex === null) return;
    const monitor = monitors[selectedMonitorIndex];
    if (!monitor) return;
    try {
      setCaptureStatus(`Saving debug screenshot...`);
      const result: string = await invoke("save_debug_screenshot", {
        monitorIndex: selectedMonitorIndex,
      });
      setCaptureStatus(result);
    } catch (err) {
      setError(String(err));
      setCaptureStatus("Error");
    }
  };

  const handleCaptureDebug = async () => {
    setShowOverlay(!showOverlay);
    if (!envInfo) {
      try {
        const info: string = await invoke("debug_env");
        setEnvInfo(info);
      } catch (err) {
        setEnvInfo(String(err));
      }
    }
  };

  const toggleAssistant = () => {
    setIsRunning(!isRunning);
  };

  useEffect(() => {
    const epoch = ++generation.current;
    let cancelled = false;
    let captureTimer: number | undefined;
    let pollTimer: number | undefined;
    clearGameState();
    setReadAge(null);
    setRegions([]);
    setError(null);
    captureFault.current = false;
    setCaptureStatus(isRunning ? "Starting reader..." : "Idle");

    const capture = async () => {
      if (cancelled || generation.current !== epoch || selectedMonitorIndex === null) return;
      const started = performance.now();
      captureBusy.current = true;
      try {
        const captured = await invoke<ProductionCapture>("capture_production_frame", {
          monitorIndex: selectedMonitorIndex,
        });
        if (!cancelled && generation.current === epoch) {
          captureFault.current = false;
          setError(null);
          showCapture(captured.screenshot_bytes);
        }
      } catch (err) {
        if (!cancelled && generation.current === epoch) {
          captureFault.current = true;
          clearGameState();
          setReadAge(null);
          setError(String(err));
          setCaptureStatus("Capture unavailable");
        }
      } finally {
        captureBusy.current = false;
        if (!cancelled)
          captureTimer = window.setTimeout(
            () => {
              inFlightCapture.current = capture();
            },
            Math.max(0, 500 - (performance.now() - started)),
          );
      }
    };
    const poll = async () => {
      if (cancelled || generation.current !== epoch) return;
      try {
        const requestStarted = performance.now();
        const result = await invoke<ProductionRead>("get_production_state", {
          username: usePokerStore.getState().username,
        });
        if (!cancelled && generation.current === epoch) {
          if (captureFault.current) {
            clearGameState();
            setReadAge(null);
          } else {
            setError(null);
            applyRead(result, epoch, performance.now() - requestStarted);
          }
        }
      } catch (err) {
        if (!cancelled && generation.current === epoch) {
          clearGameState();
          setReadAge(null);
          setError(String(err));
          setCaptureStatus("Read unavailable");
        }
      } finally {
        if (!cancelled)
          pollTimer = window.setTimeout(() => {
            inFlightPoll.current = poll();
          }, 100);
      }
    };
    // Await the previous session's in-flight IPC and stop before starting the
    // next one, so a late stop cannot kill a newly selected monitor's reader.
    const start = async () => {
      await lifecycle.current;
      if (cancelled || !isRunning || selectedMonitorIndex === null) return;
      inFlightCapture.current = capture();
      inFlightPoll.current = poll();
    };
    void start();
    return () => {
      cancelled = true;
      ++generation.current;
      window.clearTimeout(captureTimer);
      window.clearTimeout(pollTimer);
      window.clearTimeout(expiryTimer.current);
      clearGameState();
      setReadAge(null);
      lifecycle.current = Promise.allSettled([
        lifecycle.current,
        inFlightCapture.current,
        inFlightPoll.current,
      ])
        .then(() => invoke<void>("stop_production_ocr"))
        .catch(() => {
          /* A stopped or crashed reader has no display authority. */
        });
    };
  }, [isRunning, selectedMonitorIndex]);

  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      window.clearTimeout(expiryTimer.current);
    },
    [],
  );

  return (
    <div className="flex flex-col h-full bg-slate-900 text-slate-100 p-6 overflow-y-auto">
      <h1 className="text-2xl font-bold mb-4 text-emerald-400">Stake Poker Assistant</h1>

      {error && <div className="bg-red-500/20 text-red-400 p-3 rounded-md mb-4">{error}</div>}

      <div className="flex flex-col gap-4">
        <div className="bg-slate-800 p-4 rounded-md border border-slate-700">
          <label htmlFor="stake-username" className="block text-sm font-medium mb-1 text-slate-300">
            Your Stake Username:
          </label>
          <Input
            id="stake-username"
            type="text"
            className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 outline-none focus:border-emerald-500 text-slate-100"
            placeholder="Enter your username..."
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
          <p className="text-[10px] text-slate-500 mt-1 italic">
            Used to identify your position at the table via OCR.
          </p>
        </div>

        <div>
          <label htmlFor="display-monitor" className="block text-sm font-medium mb-1">
            Select Display Monitor:
          </label>
          <div className="flex gap-2">
            <div className="relative flex-grow">
              <NativeSelect
                id="display-monitor"
                className="w-full appearance-none bg-slate-800 border border-slate-700 rounded-md px-3 py-2 outline-none focus:border-emerald-500 text-slate-100"
                value={selectedMonitorIndex ?? ""}
                onChange={(e) => {
                  setSelectedMonitorIndex(e.target.value === "" ? null : Number(e.target.value));
                }}
              >
                <option value="" className="bg-slate-800 text-slate-100">
                  -- Select a Monitor --
                </option>
                {monitors.map((m, idx) => (
                  <option key={m.id} value={idx} className="bg-slate-800 text-slate-100">
                    {m.name} ({m.width}x{m.height}) {m.is_primary ? "(Primary)" : ""}
                  </option>
                ))}
              </NativeSelect>
              <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-slate-400">
                <svg
                  className="fill-current h-4 w-4"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                >
                  <path d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" />
                </svg>
              </div>
            </div>
            <Button
              onClick={() => {
                void fetchMonitors();
              }}
              className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-md transition-colors"
            >
              Refresh
            </Button>
          </div>
        </div>

        <div className="flex gap-3 mt-2">
          <Button
            disabled={selectedMonitorIndex === null}
            onClick={toggleAssistant}
            className={`px-6 py-2 rounded-md font-semibold transition-colors ${
              isRunning
                ? "bg-red-500 hover:bg-red-600 text-white"
                : "bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            }`}
          >
            {isRunning ? "Stop Assistant" : "Start Assistant"}
          </Button>

          <Button
            disabled={selectedMonitorIndex === null || isRunning}
            onClick={() => {
              void handleCapture();
            }}
            className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-md text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Test Capture
          </Button>

          <Button
            disabled={selectedMonitorIndex === null}
            onClick={() => {
              void handleSaveDebug();
            }}
            className="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-md text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Save Debug Screenshot
          </Button>
        </div>

        <div className="text-xs text-slate-400 font-mono">
          Status: {captureStatus}
          {readAge !== null && ` · ${Math.round(readAge)}ms old`}
        </div>

        <Button
          onClick={() => {
            void handleCaptureDebug();
          }}
          className={`text-xs px-3 py-1 rounded self-start transition-colors ${
            showOverlay
              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50"
              : "bg-slate-800 text-slate-400 hover:bg-slate-700"
          }`}
        >
          {showOverlay ? "Hide Debug Overlay" : "Capture Debug (Show Regions)"}
        </Button>

        {envInfo && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[10px] text-slate-500 block">Game ID</span>
                <span className="text-emerald-400 font-mono text-xs">
                  {debugInfo.gameId || "Not detected"}
                </span>
              </div>
              <div className="bg-slate-950 p-2 rounded border border-slate-800">
                <span className="text-[10px] text-slate-500 block">Your Seat Index</span>
                <span className="text-emerald-400 font-mono text-xs">
                  {debugInfo.mySeatIndex !== null ? debugInfo.mySeatIndex : "Not found"}
                </span>
              </div>
            </div>

            <div className="bg-slate-950 p-2 rounded border border-slate-800">
              <span className="text-[10px] text-slate-500 block mb-1">
                Active Seats & Usernames
              </span>
              <div className="flex flex-wrap gap-2">
                {debugInfo.inPlaySeats.length > 0 ? (
                  debugInfo.inPlaySeats.map((idx) => (
                    <div
                      key={idx}
                      className={`flex flex-col gap-1 px-2 py-1 rounded text-[10px] font-mono border transition-all ${
                        idx === debugInfo.mySeatIndex
                          ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                          : "bg-slate-900 border-slate-700 text-slate-300"
                      }`}
                      style={
                        idx === debugInfo.activeSeat
                          ? {
                              backgroundColor: debugInfo.activeSeatColor || undefined,
                              color: "#ffffff",
                            }
                          : {}
                      }
                    >
                      <span className={idx === debugInfo.activeSeat ? "font-bold" : ""}>
                        #{idx}: {debugInfo.seatUsernames[idx] || "???"}
                      </span>
                      {debugInfo.seatBanks[idx] && <span>{debugInfo.seatBanks[idx]}</span>}
                      {debugInfo.seatStatuses[idx] && <span>{debugInfo.seatStatuses[idx]}</span>}
                      {debugInfo.seatCards[idx] && (
                        <div className="flex gap-1 mt-0.5 justify-center">
                          {debugInfo.seatCards[idx].map((card, cIdx) => (
                            <Card key={cIdx} card={card} size="sm" />
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <span className="text-slate-600 text-[10px]">None detected</span>
                )}
              </div>
            </div>

            <div className="bg-slate-950 p-2 rounded border border-slate-800">
              <span className="text-[10px] text-slate-500 block">Pot</span>
              <span className="text-xs font-mono">{debugInfo.pot ?? "Unknown"}</span>
              {debugInfo.splitPot && (
                <span className="text-xs font-mono block">{debugInfo.splitPot}</span>
              )}
            </div>
            <div className="bg-slate-950 p-2 rounded border border-slate-800">
              <span className="text-[10px] text-slate-500 block mb-1">Community Cards</span>
              <div className="flex gap-2">
                {debugInfo.communityCards && debugInfo.communityCards.length > 0 ? (
                  debugInfo.communityCards.map((card, idx) => (
                    <Card key={idx} card={card} size="md" />
                  ))
                ) : (
                  <span className="text-slate-600 text-[10px]">None detected</span>
                )}
              </div>
            </div>

            <pre className="text-xs bg-slate-950 text-emerald-400 p-3 rounded-md font-mono whitespace-pre-wrap border border-slate-700">
              {envInfo}
            </pre>
          </div>
        )}

        {isRunning && (
          <div className="mt-4 p-4 border-2 border-emerald-500 rounded-lg bg-slate-800 shadow-lg">
            <h2 className="text-xl font-bold text-emerald-400 mb-2">Live Assistant HUD</h2>
            <div className="flex gap-4">
              <div className="bg-slate-900 p-3 rounded text-center flex-1">
                <span className="text-xs text-slate-400 block uppercase tracking-wide">
                  Recommendation
                </span>
                <span className="font-mono text-lg text-white">Waiting for analysis</span>
              </div>
              <div className="bg-slate-900 p-3 rounded text-center flex-1">
                <span className="text-xs text-slate-400 block uppercase tracking-wide">Equity</span>
                <span className="font-mono text-lg text-emerald-400">—</span>
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-3 text-center">
              Monitoring {selectedMonitorIndex !== null ? monitors[selectedMonitorIndex]?.name : ""}
            </p>
          </div>
        )}

        {debugImage && !isRunning && (
          <div className="mt-6 border border-slate-700 rounded-md overflow-hidden bg-slate-950 flex flex-col">
            <div className="bg-slate-800 px-3 py-1 text-xs font-mono text-slate-400 border-b border-slate-700">
              Debug View - Full Monitor
            </div>
            <div className="p-2 relative bg-black flex justify-center items-start">
              <div className="relative w-full max-w-4xl mx-auto">
                <img
                  src={debugImage}
                  alt="Captured"
                  className="w-full h-auto block rounded"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
                  }}
                />

                {showOverlay &&
                  regions.map((reg) => (
                    <div
                      key={reg.id}
                      className="absolute border border-emerald-500 bg-emerald-500/10 pointer-events-none group"
                      style={{
                        left: `${(reg.rect.x / imgDims.w) * 100}%`,
                        top: `${(reg.rect.y / imgDims.h) * 100}%`,
                        width: `${(reg.rect.w / imgDims.w) * 100}%`,
                        height: `${(reg.rect.h / imgDims.h) * 100}%`,
                      }}
                    >
                      <span className="absolute -top-4 left-0 bg-emerald-500 text-[8px] text-black px-1 font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        {reg.id}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            {debugInfo.gameId ? (
              <div className="p-4 bg-slate-900 border-t border-slate-700 flex flex-col gap-4">
                <h3 className="text-sm font-bold text-emerald-400">OCR Game State Verification</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-slate-950 p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-500 block mb-1">Game ID</span>
                    <span className="text-emerald-400 font-mono text-sm">{debugInfo.gameId}</span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded border border-slate-800">
                    <span className="text-xs text-slate-500 block mb-1">Your Seat Index</span>
                    <span className="text-emerald-400 font-mono text-sm">
                      {debugInfo.mySeatIndex !== null
                        ? debugInfo.mySeatIndex
                        : "Not found / Not sitting"}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded border border-slate-800">
                  <span className="text-xs text-slate-500 block mb-2">Community Cards</span>
                  <div className="flex gap-2">
                    {debugInfo.communityCards && debugInfo.communityCards.length > 0 ? (
                      debugInfo.communityCards.map((card, idx) => (
                        <Card key={idx} card={card} size="md" />
                      ))
                    ) : (
                      <span className="text-slate-600 text-xs">No cards detected</span>
                    )}
                  </div>
                </div>

                <div className="bg-slate-950 p-3 rounded border border-slate-800">
                  <span className="text-xs text-slate-500 block mb-2">
                    Active Seats & Usernames
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {debugInfo.inPlaySeats.length > 0 ? (
                      debugInfo.inPlaySeats.map((idx) => (
                        <div
                          key={idx}
                          className={`flex flex-col gap-2 px-3 py-1.5 rounded text-xs font-mono border transition-all ${
                            idx === debugInfo.mySeatIndex
                              ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                              : "bg-slate-900 border-slate-700 text-slate-300"
                          }`}
                          style={
                            idx === debugInfo.activeSeat
                              ? {
                                  backgroundColor: debugInfo.activeSeatColor || undefined,
                                  color: "#ffffff",
                                }
                              : {}
                          }
                        >
                          <div
                            className={idx === debugInfo.activeSeat ? "font-bold text-white" : ""}
                          >
                            Seat {idx}: {debugInfo.seatUsernames[idx] || "Unknown"}
                          </div>
                          {debugInfo.seatCards[idx] && (
                            <div className="flex gap-1 justify-center">
                              {debugInfo.seatCards[idx].map((card, cIdx) => (
                                <Card key={cIdx} card={card} size="sm" />
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <span className="text-slate-600 text-xs">No active players detected</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 bg-slate-900 border-t border-slate-700 text-slate-500 text-xs text-center">
                No game verified on screen.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
