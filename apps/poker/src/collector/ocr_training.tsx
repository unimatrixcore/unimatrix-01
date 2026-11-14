import { useEffect, useRef, useState } from "react";
import { DropdownMenuCheckboxItem } from "@unimatrix/ui/public";
import { NativeSelect, NativeSelectOption } from "@unimatrix/ui/native-select";
import { ToolMasterDetail } from "@unimatrix/chrome/tool";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Button,
  Badge,
  CardHeader,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  TooltipProvider,
  StatusDot,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@unimatrix/ui/editor";
import { TrainingActivity } from "./training-activity";
import { TrainingSetupPanel } from "./training-setup-panel";
import { useTrainingPaneScroll } from "./training-pane-scroll";
import { ScrollArea } from "@unimatrix/ui/scroll-area";
import {
  RiPlayFill as Play,
  RiStopFill as Square,
  RiLoader4Line as LoaderCircle,
  RiCpuLine as Cpu,
} from "@remixicon/react";
import {
  pokerLabDatasetSchema,
  pokerTrainingStartedSchema,
  pokerTrainingStateSchema,
  pokerTrainingDetailsSchema,
  pokerTrainingTelemetrySchema,
  type PokerTrainingRun,
  type PokerTrainingState,
  type PokerTrainingCollection,
  type PokerTrainingAnalysis,
  type PokerTrainingDetails,
} from "@unimatrix/shared";
import "./ocr_training.css";
import { readWorkspaceState, rememberWorkspaceState } from "../lib/workspace-state";

const running = (run: PokerTrainingRun) =>
  ["queued", "preparing", "training", "benchmarking"].includes(run.status);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const selectionKey = (ids: string[]) => [...ids].sort().join(",");
const numeric = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const preparationProgress = (run?: PokerTrainingRun) => {
  const progress = run?.data_progress;
  const label = progress
    ? {
        reading: "Reading captures",
        validating: "Validating crops",
        deduplicating: "Removing duplicates",
        reserving: "Reserving benchmark crops",
        ready: "Finishing data preparation",
      }[progress.stage]
    : "Preparing training data";
  const count =
    typeof progress?.completed === "number" && typeof progress.total === "number"
      ? ` · ${numeric(progress.completed)}/${numeric(progress.total)}`
      : "";
  return `${label}${count || "…"}${progress?.collection_name ? ` · ${progress.collection_name}` : ""}`;
};
const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;
const duration = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined
    ? "—"
    : seconds < 60
      ? `${Math.floor(seconds)}s`
      : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
const date = (value: number) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const runName = (run: PokerTrainingRun) =>
  run.display_name || (run.version ? `Version ${run.version}` : `Run ${date(run.created_at)}`);
const statusName = (run: PokerTrainingRun) =>
  run.status === "interrupted"
    ? "Stopped"
    : run.status === "completed"
      ? "Complete"
      : run.status.charAt(0).toUpperCase() + run.status.slice(1);
async function request(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, options);
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Request failed (${response.status})`,
    );
  return value;
}
const post = (body?: object): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

function RunDetails({
  run,
  details,
  detailsError,
  evidenceCondition,
  onEvidenceConditionChange,
}: {
  evidenceCondition: string;
  onEvidenceConditionChange: (value: string) => void;
  run: PokerTrainingRun;
  details: PokerTrainingDetails | null;
  detailsError: string;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const workers = run.workers?.length ? run.workers : (details?.workers ?? []);
  const userStopped =
    run.status === "interrupted" && (run.stopped_by_user || run.stage === "Stopped");
  const analysis = details?.analysis ?? run.analysis;
  const exclusions = analysis?.exclusions ?? run.summary?.exclusions ?? [];
  const results = run.benchmark?.results ?? [];
  const [condition, setCondition] = useState("identity");
  const [category, setCategory] = useState("all");
  const conditions = [...new Set(results.map((row) => row.condition))];
  const shownCondition = conditions.includes(condition) ? condition : conditions[0];
  const categories = [
    ...new Set(
      results.filter((row) => row.condition === shownCondition).map((row) => row.category),
    ),
  ];
  const shownCategory = categories.includes(category)
    ? category
    : categories.includes("all")
      ? "all"
      : categories[0];
  const shown = results.filter(
    (row) => row.condition === shownCondition && row.category === shownCategory,
  );
  const conditionName = (value: string) =>
    ({ identity: "Original", brightness_minus30: "Darker", jpeg80: "JPEG", scale60: "Smaller" })[
      value
    ] ?? value;

  const pane = useTrainingPaneScroll(run.id);
  return (
    <div className="training-inspector" aria-label="Version details">
      <div className="training-inspector-heading">
        <h2>{runName(run)}</h2>
        <div className="training-header-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setLogsOpen(true);
            }}
          >
            Logs
          </Button>
          <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
            <DialogContent className="training-logs-dialog">
              <DialogHeader>
                <DialogTitle>{runName(run)} logs</DialogTitle>
                <DialogDescription>Recorded worker output and run metadata.</DialogDescription>
              </DialogHeader>
              <div className="training-logs-body">
                {" "}
                <section className="training-worker-section" aria-label="GPU workers">
                  <div className="training-section-heading">
                    <h3>Models</h3>
                  </div>
                  <div className="training-worker-grid">
                    {(["general", "names"] as const).map((role) => {
                      const worker = workers.find((item) => item.role === role);
                      const waitingForBase =
                        worker?.state === "waiting" &&
                        worker.stage_id === "names-base" &&
                        workers.some(
                          (item) =>
                            item.role === "general" &&
                            item.stage_id === "base" &&
                            ["initializing", "training"].includes(item.state),
                        );
                      const workerStatus =
                        worker?.state === "waiting"
                          ? worker.waiting_reason ||
                            (waitingForBase
                              ? "Waiting for shared base model"
                              : worker.stage_id === "names-base"
                                ? "Waiting for base checkpoint"
                                : "Queued")
                          : (worker?.state ?? "No report");
                      return (
                        <article
                          key={role}
                          className="training-worker"
                          aria-label={`${role === "general" ? "General" : "Names"} worker`}
                        >
                          <div className="training-worker-heading">
                            <strong>{role === "general" ? "General" : "Names"}</strong>
                            <span>{workerStatus}</span>
                          </div>
                          <p className="training-worker-host">
                            <Cpu size={13} />
                            {worker
                              ? `${worker.host}${worker.gpu ? ` / ${worker.gpu}` : ""}`
                              : "GPU not reported"}
                          </p>
                          <dl>
                            <div>
                              <dt>Epoch</dt>
                              <dd>
                                {worker?.epoch !== null && worker?.epoch !== undefined
                                  ? `${numeric(worker.epoch, 1)} / ${numeric(worker.epochs ?? run.epochs)}`
                                  : "—"}
                              </dd>
                            </div>
                            <div>
                              <dt>Loss</dt>
                              <dd>{numeric(worker?.loss, 5)}</dd>
                            </div>
                            <div>
                              <dt>Elapsed</dt>
                              <dd>{duration(worker?.elapsed_seconds)}</dd>
                            </div>
                          </dl>
                          {worker &&
                            (worker.global_step ?? worker.step) !== undefined &&
                            (worker?.global_step ?? worker?.step) !== null && (
                              <p className="training-worker-steps">
                                Step {numeric(worker.global_step ?? worker.step)}
                                {worker.steps_per_epoch && worker.epochs
                                  ? ` / ${numeric(worker.steps_per_epoch * worker.epochs)}`
                                  : ""}
                                {worker.eta_seconds !== undefined && worker.eta_seconds !== null
                                  ? ` · ${duration(worker.eta_seconds)} remaining`
                                  : ""}
                              </p>
                            )}
                          {worker?.error && (
                            <p
                              className={
                                run.status === "failed" ? "training-error" : "training-note"
                              }
                            >
                              {worker.error}
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
                {detailsError && <p className="training-note">{detailsError}</p>}
                {details?.logs &&
                  Object.entries(details.logs)
                    .filter(([, value]) => value)
                    .map(([name, value]) => (
                      <section key={name} className="training-log" aria-label={`${name} log`}>
                        <h3>{name} log</h3>
                        <pre>{value}</pre>
                      </section>
                    ))}
                <section className="training-data-details" aria-label="Data and exclusions">
                  <h3>Data and exclusions</h3>
                  <div className="training-data-totals">
                    <span>
                      Train <strong>{numeric(run.summary?.train ?? analysis?.train)}</strong>
                    </span>
                    <span>
                      Validation{" "}
                      <strong>{numeric(run.summary?.validation ?? analysis?.validation)}</strong>
                    </span>
                    <span>
                      Test <strong>{numeric(run.summary?.test ?? analysis?.test)}</strong>
                    </span>
                    <span>
                      Duplicates{" "}
                      <strong>{numeric(run.summary?.duplicates ?? analysis?.duplicates)}</strong>
                    </span>
                    <span>
                      Excluded{" "}
                      <strong>{numeric(run.summary?.rejected ?? analysis?.rejected)}</strong>
                    </span>
                    {!!(run.summary?.reserved ?? analysis?.reserved) && (
                      <span>
                        Reserved for validation/test{" "}
                        <strong>{numeric(run.summary?.reserved ?? analysis?.reserved)}</strong>
                      </span>
                    )}
                    <span>
                      Selected training <strong>{numeric(run.summary?.selected_training)}</strong>
                    </span>
                    <span>
                      Inherited holdouts <strong>{numeric(run.summary?.inherited_holdouts)}</strong>
                    </span>
                    <span>
                      Inherited blank controls{" "}
                      <strong>{numeric(run.summary?.inherited_blank_controls)}</strong>
                    </span>
                  </div>
                  {exclusions.length > 0 ? (
                    <Table className="training-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Exclusion reason</TableHead>
                          <TableHead>Crops</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {exclusions.map((item) => (
                          <TableRow key={item.reason}>
                            <TableHead scope="row">
                              {item.reason === "protected_holdout"
                                ? "Reserved for validation/test"
                                : item.reason.replaceAll("_", " ")}
                            </TableHead>
                            <TableCell>{numeric(item.count)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="training-empty">No exclusion breakdown recorded.</p>
                  )}
                </section>
                <section className="training-data-details" aria-label="Run details">
                  <h3>Run details</h3>
                  <dl className="training-metadata">
                    <dt>Created</dt>
                    <dd>{date(run.created_at)}</dd>
                    <dt>Run ID</dt>
                    <dd>{run.id}</dd>
                    {details?.version?.dataset_sha256 && (
                      <>
                        <dt>Dataset SHA256</dt>
                        <dd>{details.version.dataset_sha256}</dd>
                      </>
                    )}
                    {details?.version?.test_sha256 && (
                      <>
                        <dt>Test SHA256</dt>
                        <dd>{details.version.test_sha256}</dd>
                      </>
                    )}
                    {(["general", "names"] as const).flatMap((role) =>
                      Object.entries(details?.version?.artifacts?.[role] ?? {}).map(
                        ([name, hash]) => (
                          <div className="training-metadata-pair" key={`${role}:${name}`}>
                            <dt>
                              {role === "general" ? "General" : "Names"} {name}
                            </dt>
                            <dd>{hash}</dd>
                          </div>
                        ),
                      ),
                    )}
                    {(["general", "names"] as const).flatMap((role) =>
                      Object.entries(details?.version?.baseline_artifacts?.[role] ?? {}).map(
                        ([name, hash]) => (
                          <div className="training-metadata-pair" key={`baseline:${role}:${name}`}>
                            <dt>
                              {role === "general" ? "General" : "Names"} baseline {name}
                            </dt>
                            <dd>{hash}</dd>
                          </div>
                        ),
                      ),
                    )}
                  </dl>
                </section>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      {run.error && !userStopped && (
        <p
          className={run.status === "failed" ? "training-error" : "training-note"}
          role={run.status === "failed" ? "alert" : undefined}
        >
          {run.error}
        </p>
      )}
      {detailsError && <p className="training-note">{detailsError}</p>}
      <ScrollArea variant="overlay" className="training-detail-scroll" viewportProps={pane}>
        <TrainingActivity
          run={run}
          workers={workers}
          telemetry={details?.telemetry}
          evidenceCondition={evidenceCondition}
          onEvidenceConditionChange={onEvidenceConditionChange}
          onCompareConditions={() => {
            setComparisonOpen(true);
          }}
        />
        {run.status === "completed" && (
          <>
            <Dialog open={comparisonOpen} onOpenChange={setComparisonOpen}>
              <DialogContent className="training-comparison-dialog">
                <DialogHeader>
                  <DialogTitle>Benchmark comparison</DialogTitle>
                  <DialogDescription>
                    Recorded model scores by condition and category.
                  </DialogDescription>
                </DialogHeader>
                <section className="training-benchmark-section" aria-label="Benchmark comparison">
                  <div className="training-section-heading">
                    <h3>Benchmark</h3>
                    <span>Frozen baseline</span>
                  </div>
                  {results.length > 0 ? (
                    <>
                      <div className="training-benchmark-filters">
                        <div role="group" aria-label="Benchmark condition">
                          {conditions.map((value) => (
                            <Button
                              key={value}
                              size="sm"
                              variant="ghost"
                              aria-pressed={value === shownCondition}
                              onClick={() => {
                                setCondition(value);
                              }}
                            >
                              {conditionName(value)}
                            </Button>
                          ))}
                        </div>
                        {categories.length > 1 && (
                          <label>
                            Category
                            <NativeSelect
                              aria-label="Benchmark category"
                              value={shownCategory}
                              onChange={(event) => {
                                setCategory(event.target.value);
                              }}
                            >
                              {categories.map((value) => (
                                <NativeSelectOption key={value} value={value}>
                                  {value === "all" ? "All categories" : value}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </label>
                        )}
                      </div>
                      <div className="training-table-scroll">
                        <Table className="training-table training-benchmark-table">
                          <TableHeader>
                            <TableRow>
                              <TableHead>Model</TableHead>
                              <TableHead>Crops</TableHead>
                              <TableHead>Exact match</TableHead>
                              <TableHead>Baseline</TableHead>
                              <TableHead>Change</TableHead>
                              <TableHead>CER</TableHead>
                              <TableHead>p95 ms</TableHead>
                              <TableHead>Regressed</TableHead>
                              <TableHead>Improved</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {shown.map((row) => (
                              <TableRow key={row.role}>
                                <TableHead scope="row">
                                  {row.role === "general" ? "General" : "Names"}
                                  {!!row.processing_errors && (
                                    <span className="training-model-errors">
                                      {numeric(row.processing_errors)}{" "}
                                      {row.processing_errors === 1 ? "error" : "errors"}
                                    </span>
                                  )}
                                </TableHead>
                                <TableCell>{numeric(row.samples)}</TableCell>
                                <TableCell>{percent(row.exact_match)}</TableCell>
                                <TableCell>{percent(row.baseline_exact_match)}</TableCell>
                                <TableCell
                                  className="training-delta"
                                  data-sign={
                                    row.baseline_exact_match === undefined ||
                                    row.baseline_exact_match === null
                                      ? "unknown"
                                      : row.exact_match >= row.baseline_exact_match
                                        ? "positive"
                                        : "negative"
                                  }
                                >
                                  {row.baseline_exact_match === undefined ||
                                  row.baseline_exact_match === null
                                    ? "—"
                                    : `${row.exact_match >= row.baseline_exact_match ? "+" : ""}${((row.exact_match - row.baseline_exact_match) * 100).toFixed(2)} pp`}
                                </TableCell>
                                <TableCell>{percent(row.cer)}</TableCell>
                                <TableCell>{numeric(row.p95_ms, 2)}</TableCell>
                                <TableCell>{numeric(row.regressions)}</TableCell>
                                <TableCell>{numeric(row.improved)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </>
                  ) : run.benchmark ? (
                    <div className="training-table-scroll">
                      <Table className="training-table">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Scope</TableHead>
                            <TableHead>Exact match</TableHead>
                            <TableHead>Baseline</TableHead>
                            <TableHead>CER</TableHead>
                            <TableHead>p95 ms</TableHead>
                            <TableHead>Regressed</TableHead>
                            <TableHead>Improved</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          <TableRow>
                            <TableHead scope="row">Combined</TableHead>
                            <TableCell>{percent(run.benchmark.exact_match)}</TableCell>
                            <TableCell>{percent(run.benchmark.baseline_exact_match)}</TableCell>
                            <TableCell>{percent(run.benchmark.cer)}</TableCell>
                            <TableCell>{numeric(run.benchmark.p95_ms, 2)}</TableCell>
                            <TableCell>{numeric(run.benchmark.regressions)}</TableCell>
                            <TableCell>{numeric(run.benchmark.improved)}</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  ) : (
                    <p className="training-empty">
                      {running(run) ? "Waiting for benchmark results." : "No benchmark results."}
                    </p>
                  )}
                </section>
              </DialogContent>
            </Dialog>
          </>
        )}
      </ScrollArea>
    </div>
  );
}

export function OcrTraining({ active }: { active: boolean }) {
  const versionsPane = useTrainingPaneScroll("versions");
  useEffect(() => {
    const main = document.getElementById("main-content");
    if (active) main?.classList.add("training-active");
    return () => main?.classList.remove("training-active");
  }, [active]);
  const [collections, setCollections] = useState<PokerTrainingCollection[]>([]);
  const [selected, setSelected] = useState<string[]>(
    () => readWorkspaceState().trainingSelection?.collections ?? [],
  );
  const epochs = 6;
  const [state, setState] = useState<PokerTrainingState | null>(null);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [cancelingAnalysis, setCancelingAnalysis] = useState("");
  const [analysisId, setAnalysisId] = useState("");
  const [analysisResultKey, setAnalysisResultKey] = useState("");
  const [revision, setRevision] = useState(0);
  const [evidenceCondition, setEvidenceCondition] = useState("identity");
  const [selectedRun, setSelectedRun] = useState(() => readWorkspaceState().trainingRun || "");
  useEffect(() => {
    if (selectedRun) rememberWorkspaceState({ trainingRun: selectedRun });
  }, [selectedRun]);
  const [details, setDetails] = useState<PokerTrainingDetails | null>(null);
  const [detailsError, setDetailsError] = useState("");
  const [gpuChecking, setGpuChecking] = useState(false);
  const [gpuProbeFailed, setGpuProbeFailed] = useState(false);
  const alive = useRef(true);
  const requestedAnalysis = useRef("");
  const analysisPostPending = useRef(false);
  const cancelRequest = useRef("");
  const selectionChanged = useRef(false);
  const ids = selectionKey(selected);
  const selectionTarget = JSON.stringify([ids, epochs]);
  const lastSelectionTarget = useRef(selectionTarget);
  const currentAnalysisKey = JSON.stringify([
    ids,
    epochs,
    state?.analysis_protocol ?? "",
    [...selected]
      .sort()
      .map((id) => [
        id,
        state?.collections?.find((collection) => collection.id === id)?.revision ?? "",
      ]),
  ]);
  const latestAnalysisKey = useRef(currentAnalysisKey);
  latestAnalysisKey.current = currentAnalysisKey;
  const activeRun = state?.runs.find(running);
  const activeCollections = activeRun?.collections;
  useEffect(() => {
    if (activeCollections?.length)
      setSelected((prior) =>
        selectionKey(prior) === selectionKey(activeCollections) ? prior : [...activeCollections],
      );
  }, [activeCollections]);
  const activeAnalysis = state?.analyses.find(running);
  const analysisRunning = !!activeAnalysis;
  const busy = starting || resuming || !!activeRun;
  const loaded = !!state;
  const validEpochs = Number.isInteger(epochs) && epochs >= 1 && epochs <= 100;
  useEffect(() => {
    if (!validEpochs) return;
    const trainingSelection = { collections: selected, epochs };
    if (
      JSON.stringify(readWorkspaceState().trainingSelection) !== JSON.stringify(trainingSelection)
    )
      rememberWorkspaceState({ trainingSelection });
  }, [selected, epochs, validEpochs]);
  const analysisRun =
    analysisResultKey === currentAnalysisKey
      ? state?.analyses.find(
          (run) =>
            run.id === analysisId && selectionKey(run.collections) === ids && run.epochs === epochs,
        )
      : undefined;
  const readiness: PokerTrainingAnalysis | null =
    analysisRun?.status === "completed" ? (analysisRun.analysis ?? null) : null;
  const checking = !!cancelingAnalysis || (!!ids && (analyzing || analysisRunning));
  const gpuCacheFresh = !!state?.gpu_status && Date.now() - state.gpu_status.checked_at <= 30000;
  const gpuReadyFor = (names: number | null | undefined) =>
    gpuCacheFresh &&
    !gpuChecking &&
    !gpuProbeFailed &&
    (names === 0 ? ["local"] : ["local", "unimatrix-01"]).every((host) =>
      state?.gpu_status?.devices.some((device) => device.host === host && device.ready),
    );
  const computeReady = gpuReadyFor(readiness?.names);
  const startReady = !!(
    selected.length &&
    validEpochs &&
    state?.setup.ready &&
    readiness?.ready &&
    computeReady &&
    !checking &&
    !busy
  );
  const inspectedRun =
    state?.runs.find((run) => run.id === selectedRun) ?? activeRun ?? state?.runs[0];
  const resumable =
    !!inspectedRun?.can_resume && ["failed", "interrupted"].includes(inspectedRun.status);
  const resumeReady = resumable && !busy && gpuReadyFor(inspectedRun?.analysis?.names);
  const sourceRun = activeRun ?? (resumable ? inspectedRun : undefined);
  const displayedSelection = sourceRun?.collections ?? selected;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let probeChecking = false;
    let lastProbeAt = 0;
    let cacheCheckedAt = 0;
    const probe = async () => {
      lastProbeAt = Date.now();
      probeChecking = true;
      setGpuChecking(true);
      setGpuProbeFailed(false);
      try {
        const value = await request("/api/training/probe", {
          ...post(),
          signal: controller.signal,
        });
        probeChecking = !!(
          value &&
          typeof value === "object" &&
          "checking" in value &&
          value.checking === true
        );
        if (!disposed) setGpuChecking(probeChecking);
      } catch {
        probeChecking = false;
        if (!disposed) {
          setGpuChecking(false);
          setGpuProbeFailed(true);
        }
      }
    };
    const load = async () => {
      try {
        const expired = !cacheCheckedAt || Date.now() - cacheCheckedAt >= 30000;
        if (!lastProbeAt || (expired && (!probeChecking || Date.now() - lastProbeAt >= 30000)))
          await probe();
        if (disposed) return;
        const next = pokerTrainingStateSchema.parse(
          await request("/api/training", { signal: controller.signal }),
        );
        if (disposed) return;
        setState(next);
        if (next.collections) setCollections(next.collections);
        cacheCheckedAt = next.gpu_status?.checked_at ?? 0;
        if (cacheCheckedAt && Date.now() - cacheCheckedAt < 30000) {
          probeChecking = false;
          setGpuChecking(false);
          setGpuProbeFailed(false);
        }
        const delay =
          next.runs.some(running) || next.analyses.some(running) || probeChecking
            ? 2000
            : Math.max(1000, cacheCheckedAt + 30000 - Date.now());
        timer = setTimeout(() => {
          void load();
        }, delay);
      } catch (cause) {
        if (!disposed) setError(message(cause));
      } finally {
        if (!disposed) document.getElementById("loading-overlay")?.classList.remove("active");
      }
    };
    void load();

    void request("/api/datasets", { signal: controller.signal })
      .then((value) => {
        if (
          !value ||
          typeof value !== "object" ||
          !("datasets" in value) ||
          !Array.isArray(value.datasets)
        )
          throw new Error("Invalid collections response");
        const rows = value.datasets
          .map((item) => pokerLabDatasetSchema.parse(item))
          .filter((item) => !item.archived);
        if (!disposed) {
          setCollections((prior) =>
            rows.map((row) => ({
              ...prior.find((item) => item.id === row.id),
              id: row.id,
              name: row.name,
            })),
          );
          setSelected((prior) => prior.filter((id) => rows.some((row) => row.id === id)));
        }
      })
      .catch((cause) => {
        if (!disposed) setError(message(cause));
      });
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, revision]);
  useEffect(() => {
    if (lastSelectionTarget.current !== selectionTarget) {
      selectionChanged.current = true;
      lastSelectionTarget.current = selectionTarget;
    }
  }, [selectionTarget]);
  useEffect(() => {
    if (
      !active ||
      busy ||
      !selectionChanged.current ||
      !activeAnalysis ||
      activeAnalysis.kind !== "analysis" ||
      !["queued", "preparing"].includes(activeAnalysis.status) ||
      (selectionKey(activeAnalysis.collections) === ids && activeAnalysis.epochs === epochs) ||
      cancelRequest.current === activeAnalysis.id
    )
      return;
    const id = activeAnalysis.id;
    cancelRequest.current = id;
    setCancelingAnalysis(id);
    let canceled = false;
    void request(`/api/training/${encodeURIComponent(id)}/cancel`, post())
      .then((value) => {
        const { run } = pokerTrainingStartedSchema.parse(value);
        if (run.id !== id || run.kind !== "analysis")
          throw new Error("Invalid preparation cancellation response");
        canceled = true;
        if (!alive.current) return;
        requestedAnalysis.current = "";
        setState((prior) =>
          prior
            ? { ...prior, analyses: prior.analyses.map((item) => (item.id === id ? run : item)) }
            : prior,
        );
      })
      .catch((cause) => {
        if (alive.current) setError(message(cause));
      })
      .finally(() => {
        cancelRequest.current = "";
        if (alive.current) {
          setCancelingAnalysis("");
          if (canceled) setRevision((value) => value + 1);
        }
      });
  }, [active, busy, activeAnalysis?.id, ids, epochs, revision]);
  useEffect(() => {
    setAnalysisId("");
    setAnalyzing(false);
  }, [currentAnalysisKey]);
  useEffect(() => {
    if (
      !active ||
      !ids ||
      !validEpochs ||
      !loaded ||
      busy ||
      analysisRunning ||
      cancelingAnalysis ||
      analysisPostPending.current
    )
      return;
    const key = currentAnalysisKey;
    if (requestedAnalysis.current === key) return;
    let disposed = false;
    let pending = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestedAnalysis.current = key;
      pending = true;
      analysisPostPending.current = true;
      setAnalyzing(true);
      setError("");
      void request("/api/training/analyze", {
        ...post({ collections: ids.split(","), epochs }),
        signal: controller.signal,
      })
        .then((value) => {
          const result = pokerTrainingStartedSchema.parse(value);
          pending = false;
          // Polling can observe the accepted job before its POST response arrives.
          if (alive.current && latestAnalysisKey.current === key) {
            setAnalysisId(result.run.id);
            setAnalysisResultKey(key);
            setState((prior) =>
              prior
                ? {
                    ...prior,
                    analyses: [
                      prior.analyses.find((item) => item.id === result.run.id && !running(item)) ??
                        result.run,
                      ...prior.analyses.filter((run) => run.id !== result.run.id),
                    ],
                  }
                : prior,
            );
            setRevision((value) => value + 1);
          } else if (alive.current && running(result.run)) {
            setState((prior) =>
              prior
                ? {
                    ...prior,
                    analyses: [
                      result.run,
                      ...prior.analyses.filter((run) => run.id !== result.run.id),
                    ],
                  }
                : prior,
            );
          }
        })
        .catch((cause) => {
          if (alive.current && latestAnalysisKey.current === key) {
            setError(message(cause));
          }
        })
        .finally(() => {
          analysisPostPending.current = false;
          if (!disposed) setAnalyzing(false);
          else if (alive.current) setRevision((value) => value + 1);
        });
    }, 300);
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (!pending || !alive.current) controller.abort();
      setAnalyzing(false);
    };
  }, [
    active,
    ids,
    epochs,
    validEpochs,
    loaded,
    busy,
    analysisRunning,
    cancelingAnalysis,
    revision,
    currentAnalysisKey,
  ]);
  useEffect(() => {
    if (!active || !inspectedRun) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setDetails(null);
    setDetailsError("");
    const load = async () => {
      try {
        const payload = await request(
          `/api/training/${encodeURIComponent(inspectedRun.id)}${inspectedRun.status === "completed" ? `?condition=${encodeURIComponent(evidenceCondition)}` : ""}`,
          {
            signal: controller.signal,
          },
        );
        const telemetry =
          payload && typeof payload === "object" && "telemetry" in payload
            ? pokerTrainingTelemetrySchema.safeParse(payload.telemetry)
            : null;
        const next = pokerTrainingDetailsSchema.parse(
          payload && typeof payload === "object"
            ? { ...payload, telemetry: telemetry?.success ? telemetry.data : undefined }
            : payload,
        );
        if (!disposed) {
          setDetails(next);
          if (running(next.run))
            timer = setTimeout(() => {
              void load();
            }, 2000);
        }
      } catch (cause) {
        if (!disposed) setDetailsError(message(cause));
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, inspectedRun?.id, inspectedRun?.status, evidenceCondition]);
  const start = async () => {
    if (!startReady) return;
    setStarting(true);
    setError("");
    try {
      const result = pokerTrainingStartedSchema.parse(
        await request("/api/training", post({ collections: selected, epochs })),
      );
      if (alive.current) {
        setState((prior) =>
          prior
            ? {
                ...prior,
                runs: [result.run, ...prior.runs.filter((run) => run.id !== result.run.id)],
              }
            : prior,
        );
        setSelectedRun(result.run.id);
        setRevision((value) => value + 1);
      }
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current) setStarting(false);
    }
  };
  const resume = async () => {
    if (!resumeReady || !inspectedRun) return;
    setResuming(true);
    setError("");
    try {
      const result = pokerTrainingStartedSchema.parse(
        await request(`/api/training/${encodeURIComponent(inspectedRun.id)}/resume`, post()),
      );
      if (alive.current) {
        setState((prior) =>
          prior
            ? {
                ...prior,
                runs: prior.runs.map((run) => (run.id === result.run.id ? result.run : run)),
              }
            : prior,
        );
        setSelectedRun(result.run.id);
        setRevision((value) => value + 1);
      }
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current) setResuming(false);
    }
  };
  const stop = async () => {
    if (!activeRun) return;
    setStopping(true);
    setError("");
    try {
      await request(`/api/training/${encodeURIComponent(activeRun.id)}/cancel`, post());
      if (alive.current) setRevision((value) => value + 1);
    } catch (cause) {
      if (alive.current) setError(message(cause));
    } finally {
      if (alive.current) setStopping(false);
    }
  };
  const analyzedCollections = (sourceRun?.analysis ?? readiness)?.collections ?? [];
  const visibleRun =
    details &&
    details.run.id === inspectedRun?.id &&
    (details.run.updated_at ?? 0) >= (inspectedRun.updated_at ?? 0)
      ? details.run
      : inspectedRun;
  const blockedReason =
    activeRun || resumable || startReady
      ? ""
      : !loaded
        ? "Loading training state…"
        : !selected.length
          ? "Select a collection"
          : !state?.setup.ready
            ? state?.setup.error || "Training setup unavailable"
            : checking
              ? ""
              : !readiness
                ? ""
                : !readiness.ready
                  ? readiness.blockers[0] || "Selected data is not ready"
                  : !computeReady
                    ? gpuProbeFailed
                      ? "GPU availability check failed"
                      : gpuChecking || !gpuCacheFresh
                        ? "Checking GPU availability…"
                        : "Required GPU unavailable"
                    : "";
  const controls = (
    <>
      {" "}
      {activeRun ? (
        <Button
          size="sm"
          variant="destructive"
          disabled={stopping}
          onClick={() => {
            void stop();
          }}
        >
          <Square size={13} />
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      ) : resumable ? (
        <Button
          size="sm"
          disabled={!resumeReady}
          onClick={() => {
            void resume();
          }}
        >
          <Play size={13} />
          {resuming ? "Resuming…" : "Resume training"}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={!startReady}
          onClick={() => {
            void start();
          }}
        >
          <Play size={13} />
          {starting ? "Starting…" : "Start training"}
        </Button>
      )}
    </>
  );
  const collectionChoices = (
    <>
      {collections.map((collection) => {
        const counts = analyzedCollections.find((item) => item.id === collection.id) ?? collection;
        return (
          <DropdownMenuCheckboxItem
            key={collection.id}
            aria-label={collection.name}
            checked={displayedSelection.includes(collection.id)}
            disabled={busy || resumable}
            onSelect={(event) => {
              event.preventDefault();
            }}
            onCheckedChange={(checked) => {
              requestedAnalysis.current = "";
              setAnalysisId("");
              setSelected((prior) =>
                checked === true
                  ? [...prior, collection.id]
                  : prior.filter((id) => id !== collection.id),
              );
            }}
          >
            <span>{collection.name}</span>
            <span className="training-option-counts">
              {numeric(counts.eligible)} eligible · {numeric(counts.pending)} pending
            </span>
          </DropdownMenuCheckboxItem>
        );
      })}
      {!collections.length && (
        <p className="training-empty">
          {state ? "No collections available." : "Loading collections…"}
        </p>
      )}
    </>
  );
  const readinessStatus = (
    <>
      {" "}
      <div className="training-readiness" role="status">
        <StatusDot
          tone={
            startReady
              ? "ok"
              : activeRun || checking || gpuChecking
                ? "warn"
                : !selected.length
                  ? "idle"
                  : "bad"
          }
          label={
            startReady
              ? "Ready"
              : activeRun
                ? statusName(activeRun)
                : checking || gpuChecking
                  ? "Checking"
                  : !selected.length
                    ? "No collection selected"
                    : "Blocked"
          }
        />
        {activeRun ? (
          <span>
            {activeRun.status === "preparing" || activeRun.status === "queued" ? (
              preparationProgress(activeRun)
            ) : (
              <>{statusName(activeRun)}</>
            )}
          </span>
        ) : resumable && sourceRun ? (
          <span>Resume available</span>
        ) : checking ? (
          <>
            <LoaderCircle size={14} className="training-spinner" />
            {cancelingAnalysis ? "Stopping preparation…" : preparationProgress(activeAnalysis)}
          </>
        ) : readiness ? (
          <>
            <span className="training-readiness-state" data-ready={startReady}>
              {startReady ? "Ready" : checking || gpuChecking ? "Checking…" : "Blocked"}
            </span>
          </>
        ) : analysisRun?.status === "failed" ? (
          <span>{analysisRun.error || "Data preparation failed."}</span>
        ) : (
          <span>{selected.length ? "Preparing training data…" : "No collections selected."}</span>
        )}
      </div>
      {readiness && readiness.blockers.length > 1 ? (
        <ul className="training-blockers">
          {readiness.blockers.slice(1).map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
  const computeStatus = (
    <>
      {" "}
      <div
        className="training-compute"
        role="group"
        aria-label="Compute availability"
        title={
          state?.gpu_status
            ? `Last checked ${date(state.gpu_status.checked_at)}`
            : "GPU availability has not been checked"
        }
      >
        {["local", "unimatrix-01"].map((host) => {
          const device = state?.gpu_status?.devices.find((item) => item.host === host);
          const checkingDevice = gpuChecking || !gpuCacheFresh;
          const status = gpuProbeFailed
            ? "Check failed"
            : checkingDevice
              ? "Checking…"
              : device?.ready
                ? "Ready"
                : "Unavailable";
          const description = `${host} / ${device?.gpu || "GPU not reported"}: ${status}${device?.error ? ` · ${device.error}` : ""}`;
          const tone = gpuProbeFailed
            ? "bad"
            : checkingDevice
              ? "checking"
              : device?.ready
                ? "good"
                : "bad";
          return (
            <Tooltip key={host}>
              <TooltipTrigger asChild>
                <span
                  className="training-compute-device"
                  tabIndex={0}
                  role="img"
                  aria-label={description}
                >
                  <Cpu
                    aria-hidden="true"
                    size={14}
                    className={`training-device-icon training-device-${tone}`}
                  />
                  <span>{host}</span>
                  <strong>{device?.gpu || "—"}</strong>
                </span>
              </TooltipTrigger>
              <TooltipContent>{description}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </>
  );
  return (
    <TooltipProvider>
      <section className="training-workspace" aria-label="OCR Training">
        {error && (
          <div className="training-error" role="alert">
            {error}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setError("");
                requestedAnalysis.current = "";
                setRevision((value) => value + 1);
              }}
            >
              Retry
            </Button>
          </div>
        )}
        {state && !state.setup.ready && (
          <p className="training-error" role="alert">
            {state.setup.error || "Training setup is unavailable."}
          </p>
        )}

        <TrainingSetupPanel
          controls={controls}
          choices={collectionChoices}
          blockedReason={blockedReason}
          readiness={readinessStatus}
          compute={computeStatus}
          selectedCount={displayedSelection.length}
          counts={
            <>
              <span>
                {numeric(
                  sourceRun?.summary?.accepted ??
                    sourceRun?.analysis?.accepted ??
                    readiness?.accepted,
                )}{" "}
                eligible
              </span>
              <span>
                {numeric(sourceRun?.summary?.test ?? sourceRun?.analysis?.test ?? readiness?.test)}{" "}
                benchmark crops
              </span>
            </>
          }
        />
        <ToolMasterDetail
          variant="cards"
          detailScroll="managed"
          className="training-master-detail"
          listHeader={
            <CardHeader className="training-rail-heading">
              <h2>Versions</h2>
            </CardHeader>
          }
          list={
            <section aria-label="Model versions" className="training-versions-pane">
              <ScrollArea
                variant="overlay"
                className="training-versions-scroll"
                viewportProps={versionsPane}
              >
                {" "}
                {state?.runs.length ? (
                  <div className="training-version-list">
                    {state.runs.map((run) => (
                      <button
                        type="button"
                        key={run.id}
                        className="training-version"
                        aria-pressed={run.id === inspectedRun?.id}
                        onClick={() => {
                          setSelectedRun(run.id);
                        }}
                      >
                        <span className="training-version-name">{runName(run)}</span>
                        <Badge
                          variant={run.status === "failed" ? "destructive" : "outline"}
                          className="training-version-status"
                          data-status={run.status}
                        >
                          {statusName(run)}
                        </Badge>
                        <time dateTime={new Date(run.created_at).toISOString()}>
                          {date(run.created_at)}
                        </time>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="training-empty">No trained versions.</p>
                )}
              </ScrollArea>
            </section>
          }
          detail={
            <>
              {visibleRun ? (
                <RunDetails
                  key={visibleRun.id}
                  run={visibleRun}
                  details={details?.run.id === visibleRun.id ? details : null}
                  detailsError={detailsError}
                  evidenceCondition={evidenceCondition}
                  onEvidenceConditionChange={setEvidenceCondition}
                />
              ) : (
                <div className="training-inspector">
                  {activeAnalysis ? (
                    <TrainingActivity run={activeAnalysis} workers={[]} telemetry={undefined} />
                  ) : null}
                </div>
              )}
            </>
          }
        />
      </section>
    </TooltipProvider>
  );
}
