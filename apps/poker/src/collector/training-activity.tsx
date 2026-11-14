import { useState } from "react";
import { NativeSelect, NativeSelectOption } from "@unimatrix/ui/native-select";
import {
  Button,
  StatusDot,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@unimatrix/ui/editor";
import type {
  PokerTrainingRun,
  PokerTrainingTelemetry,
  PokerTrainingWorker,
} from "@unimatrix/shared";
import { RiArrowRightLine } from "@remixicon/react";
import { mediaUrl } from "../lib/native-transport";

type History = PokerTrainingTelemetry["histories"][number];
type BenchmarkCase = NonNullable<PokerTrainingTelemetry["benchmark"]>["cases"][number];
const roles = ["general", "names"] as const;
const roleName = (role: string) => (role === "general" ? "General" : "Names");
const number = (value: number | null | undefined, digits = 0) =>
  value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const phaseName = (id: string | undefined) =>
  ({
    base: "Shared base",
    general: "General refinement",
    "names-base": "Names specialization",
    names: "Names refinement",
  })[id ?? ""] ??
  id ??
  "Phase not reported";
export function LossHistory({ history }: { history: History }) {
  const points = [
    ...new Map(
      history.points
        .filter((point) => Number.isFinite(point.step) && Number.isFinite(point.loss))
        .map((point) => [point.step, point]),
    ).values(),
  ]
    .sort((a, b) => a.step - b.step)
    .slice(-160);
  if (!points.length) return <p className="training-telemetry-empty">No loss history recorded.</p>;
  const low = Math.min(...points.map((point) => point.loss)),
    high = Math.max(...points.map((point) => point.loss));
  const first = points[0]!,
    last = points.at(-1)!;
  const x = (step: number) =>
    36 + ((step - first.step) / Math.max(1, last.step - first.step)) * 356;
  const y = (loss: number) => (high === low ? 70 : 114 - ((loss - low) / (high - low)) * 94);
  return (
    <figure className="training-loss-history" data-stage={history.stage_id}>
      <figcaption>Loss</figcaption>
      <svg
        viewBox="0 0 420 146"
        role="img"
        aria-label={`${roleName(history.role)} ${phaseName(history.stage_id)} recorded loss, ${points.length} observations`}
      >
        <path className="training-chart-axis" d="M36 16V116H396M36 66H396" />
        {points.length > 1 && (
          <polyline points={points.map((point) => `${x(point.step)},${y(point.loss)}`).join(" ")} />
        )}
        <circle cx={x(last.step)} cy={y(last.loss)} r="3" />
        <text x="2" y="22">
          {number(high, 3)}
        </text>
        <text x="2" y="116">
          {number(low, 3)}
        </text>
        <text x="36" y="138">
          {number(first.step)}
        </text>
        <text x="300" y="138">
          Step {number(last.step)}
        </text>
      </svg>
    </figure>
  );
}
function WorkerLane({
  role,
  worker,
  histories,
  baseActive,
  baseComplete,
}: {
  role: "general" | "names";
  worker: PokerTrainingWorker | undefined;
  histories: History[];
  baseActive: boolean;
  baseComplete: boolean;
}) {
  const current = worker?.stage_id;
  const phases = role === "general" ? ["base", "general"] : ["base", "names-base", "names"];
  const phaseIndex = phases.indexOf(current ?? "");
  const waitingForBase =
    role === "names" &&
    current === "names-base" &&
    !baseComplete &&
    (baseActive ||
      /shared base model|base checkpoint/i.test(worker?.waiting_reason ?? "") ||
      (worker?.state === "waiting" && !/transfer/i.test(worker.waiting_reason ?? "")));
  const starting = worker?.state === "initializing" || worker?.state === "waiting";
  const operationReason = ["completed", "failed", "interrupted", "inherited"].includes(
    worker?.state ?? "",
  )
    ? undefined
    : worker?.waiting_reason;
  const state =
    operationReason ||
    (worker?.state === "waiting"
      ? waitingForBase
        ? "Waiting for shared base model"
        : current === "names-base"
          ? "Waiting for base checkpoint"
          : "Waiting for worker"
      : worker?.state === "initializing"
        ? "Initializing model and data loader"
        : worker?.state === "training"
          ? "Training"
          : worker?.state === "completed"
            ? `${phaseName(current)} complete`
            : worker?.state === "inherited"
              ? "Using active model"
              : worker?.state === "interrupted"
                ? "Training stopped"
                : worker?.state === "failed"
                  ? "Training failed"
                  : "Waiting for worker report");
  const currentHistory = histories.findLast(
    (history) => history.role === role && history.stage_id === current && history.points.length,
  );
  const previousPhase =
    current === "general" ? "base" : current === "names" ? "names-base" : undefined;
  const previousHistory = previousPhase
    ? histories.findLast(
        (history) =>
          history.role === role && history.stage_id === previousPhase && history.points.length,
      )
    : undefined;
  const shownHistory = currentHistory ?? previousHistory;
  const epochs = worker?.epochs && worker.epochs > 0 ? worker.epochs : undefined;
  const epoch = !starting && worker?.epoch != null ? worker.epoch : undefined;
  const epochProgress =
    epoch != null && epochs ? Math.max(0, Math.min(epoch, epochs)) / epochs : undefined;
  const segments = epochs ? Math.min(100, Math.ceil(epochs)) : 0;
  return (
    <article
      className="training-job-lane"
      aria-label={`${roleName(role)} worker`}
      data-stage={current}
      data-state={worker?.state}
    >
      <div className="training-job-latest">
        <div className="training-job-heading">
          <h3>{roleName(role)}</h3>
          <StatusDot
            tone={
              worker?.state === "failed"
                ? "bad"
                : starting
                  ? "warn"
                  : worker?.state === "training" || worker?.state === "completed"
                    ? "ok"
                    : "idle"
            }
            label={state}
          />
        </div>
        <p className="training-worker-host">
          {worker
            ? `${worker.host}${worker.gpu ? ` · ${worker.gpu}` : " · GPU not reported"}`
            : "GPU not reported"}
        </p>
        <ol className="training-stage-path" aria-label={`${roleName(role)} training phases`}>
          {phases.map((phase, index) => {
            const complete =
              phaseIndex >= 0 &&
              !waitingForBase &&
              (index < phaseIndex || (index === phaseIndex && worker?.state === "completed"));
            const active = waitingForBase ? index === 0 : index === phaseIndex && !complete;
            return (
              <li
                key={phase}
                data-state={complete ? "complete" : active ? "active" : "pending"}
                aria-current={active ? "step" : undefined}
              >
                {complete ? "✓ " : ""}
                {phase === "base"
                  ? "Shared base"
                  : phase === "names-base"
                    ? "Specialization"
                    : "Refinement"}
              </li>
            );
          })}
        </ol>
        <div className="training-current-phase">
          <span className="training-phase-ordinal">
            {phaseIndex >= 0
              ? `${waitingForBase ? "Next phase" : "Phase"} ${phaseIndex + 1} of ${phases.length}`
              : "Current phase"}
          </span>
          <strong>{phaseName(current)}</strong>
        </div>
        <div className="training-epoch">
          <div className="training-epoch-heading">
            <span>Epoch</span>
            <span className="training-epoch-value">
              {number(epoch, 1)} / {number(epochs)}
            </span>
          </div>
          {epochs ? (
            <div
              className="training-epoch-progress"
              role="progressbar"
              aria-label={`${roleName(role)} epoch progress`}
              aria-valuemin={0}
              aria-valuemax={epochs}
              aria-valuenow={epoch == null ? undefined : Math.min(epoch, epochs)}
              aria-valuetext={
                epoch == null
                  ? `${number(epochs)} epochs planned; ${state}`
                  : `Epoch ${number(epoch, 1)} of ${number(epochs)}; ${state}`
              }
            >
              {Array.from({ length: segments }, (_, index) => (
                <span
                  key={index}
                  data-state={
                    epochProgress == null || epochProgress * segments <= index
                      ? "pending"
                      : epochProgress * segments > index + 1 || worker?.state === "completed"
                        ? "complete"
                        : "active"
                  }
                />
              ))}
            </div>
          ) : null}
          {starting && epochs ? (
            <span className="training-epoch-planned">{number(epochs)} epochs planned</span>
          ) : null}
        </div>
        <p className="training-job-operation">{state}</p>
        <dl className="training-job-metrics">
          <div>
            <dt>Loss</dt>
            <dd>{number(starting ? undefined : worker?.loss, 5)}</dd>
          </div>
          <div>
            <dt>Step</dt>
            <dd>{number(starting ? undefined : (worker?.global_step ?? worker?.step))}</dd>
          </div>
        </dl>
        {worker?.error && <p className="training-error">{worker.error}</p>}
      </div>
      <div className="training-job-charts">
        {shownHistory ? (
          <>
            <span className="training-chart-phase">
              {currentHistory ? "Loss" : "Previous phase loss"} · {phaseName(shownHistory.stage_id)}
            </span>
            <LossHistory history={shownHistory} />
          </>
        ) : (
          <div className="training-chart-pending">
            <strong>
              {worker?.state === "waiting"
                ? `${phaseName(current)} queued`
                : worker?.state === "initializing"
                  ? `${phaseName(current)} initializing`
                  : worker?.state === "failed" || worker?.state === "interrupted"
                    ? `${phaseName(current)} stopped`
                    : current
                      ? `${phaseName(current)} loss`
                      : "Waiting for worker report"}
            </strong>
            <span>
              {worker?.state === "inherited"
                ? "This model is reused without training."
                : ["completed", "failed", "interrupted"].includes(worker?.state ?? "")
                  ? "No loss measurements retained for this phase."
                  : "Loss appears after the first training measurement."}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}
function CaseCard({ row }: { row: BenchmarkCase }) {
  const outcome =
    row.baseline_exact === true && row.candidate_exact === false
      ? "Regressed"
      : row.baseline_exact === false && row.candidate_exact === true
        ? "Improved"
        : row.candidate_exact === null || row.baseline_exact === null
          ? "Pair incomplete"
          : "Unchanged";
  return (
    <article
      className="training-case"
      aria-label={`${roleName(row.role)} benchmark sample ${row.sample_id}`}
      data-outcome={outcome.toLowerCase()}
    >
      <div className="training-case-image">
        {row.image_url ? (
          <img src={mediaUrl(row.image_url)} alt={`Frozen crop: ${row.label}`} loading="lazy" />
        ) : (
          <span>Frozen crop unavailable</span>
        )}
      </div>
      <dl className="training-predictions">
        <div>
          <dt>Frozen baseline</dt>
          <dd data-correct={row.baseline_exact}>{row.baseline_prediction ?? "Pending"}</dd>
        </div>
        <div>
          <dt>Candidate</dt>
          <dd data-correct={row.candidate_exact}>{row.candidate_prediction ?? "Pending"}</dd>
        </div>
      </dl>
      <div className="training-case-target">
        <span>Target · {row.label}</span>
        <strong>{outcome}</strong>
      </div>
    </article>
  );
}
type Result = NonNullable<NonNullable<PokerTrainingRun["benchmark"]>["results"]>[number];
const rate = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(2)}%`;
const outcomeRank = (row: BenchmarkCase) =>
  row.baseline_exact === true && row.candidate_exact === false
    ? 0
    : row.baseline_exact === false && row.candidate_exact === true
      ? 1
      : 2;
function RoleEvidence({
  role,
  cases,
  result,
  completed,
}: {
  role: "general" | "names";
  cases: BenchmarkCase[];
  result: Result | undefined;
  completed: boolean;
}) {
  const [index, setIndex] = useState(0);
  const ordered = [...cases].sort((a, b) => outcomeRank(a) - outcomeRank(b));
  const shown = Math.min(index, Math.max(0, ordered.length - 1));
  const row = ordered[shown];
  const change =
    result?.baseline_exact_match == null
      ? null
      : (result.exact_match - result.baseline_exact_match) * 100;
  return (
    <section className="training-pair-lane" aria-label={`${roleName(role)} benchmark evidence`}>
      <h3>{roleName(role)}</h3>
      {completed && (
        <section className="training-role-score" aria-label={`${roleName(role)} results`}>
          {result ? (
            <>
              <div className="training-score-primary">
                <strong>{rate(result.exact_match)}</strong>
                <span>exact match · {number(result.samples)} crops</span>
              </div>
              <div className="training-score-baseline">
                <span>Baseline {rate(result.baseline_exact_match)}</span>
                <strong data-negative={change !== null && change < 0}>
                  {change === null
                    ? "Change unavailable"
                    : `${change >= 0 ? "+" : ""}${change.toFixed(2)} pp`}
                </strong>
              </div>
              <div className="training-score-counts">
                <span>
                  {result.regressions === 0
                    ? "No regressions"
                    : `${number(result.regressions)} regressions`}
                </span>
                <span>{number(result.improved)} improvements</span>
              </div>
            </>
          ) : (
            <p className="training-telemetry-empty">
              Per-model scores unavailable for this version.
            </p>
          )}
        </section>
      )}
      {row ? (
        <CaseCard row={row} />
      ) : (
        <p className="training-case-empty">
          {completed ? "No matching paired examples retained." : "Waiting for paired predictions."}
        </p>
      )}
      {completed && ordered.length > 0 && (
        <div className="training-case-navigation">
          <span>
            Retained example {shown + 1} / {ordered.length}
          </span>
          <div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Previous ${roleName(role)} example`}
              disabled={shown === 0}
              onClick={() => {
                setIndex(shown - 1);
              }}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Next ${roleName(role)} example`}
              disabled={shown >= ordered.length - 1}
              onClick={() => {
                setIndex(shown + 1);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
function BenchmarkEvidence({
  telemetry,
  run,
  evidenceCondition,
  onEvidenceConditionChange,
  initialFilter = "all",
}: {
  initialFilter?: string;
  telemetry: PokerTrainingTelemetry | undefined;
  run: PokerTrainingRun;
  evidenceCondition: string | undefined;
  onEvidenceConditionChange: ((value: string) => void) | undefined;
}) {
  const benchmark = telemetry?.benchmark;
  const completed = run.status === "completed";
  const [filter, setFilter] = useState(initialFilter);
  const results = run.benchmark?.results ?? [];
  const conditions = [
    ...new Set([
      ...results.map((row) => row.condition),
      ...(benchmark?.cases.map((row) => row.condition) ?? []),
    ]),
  ];
  const [condition, setCondition] = useState("identity");
  const selectedCondition = completed
    ? (evidenceCondition ?? condition)
    : (benchmark?.condition ?? conditions[0]);
  const shownCondition =
    selectedCondition && conditions.includes(selectedCondition) ? selectedCondition : conditions[0];
  const cases = (benchmark?.cases ?? []).filter(
    (row) =>
      row.condition === shownCondition &&
      (filter === "all" ||
        (filter === "regressed"
          ? row.baseline_exact === true && row.candidate_exact === false
          : row.baseline_exact === false && row.candidate_exact === true)),
  );
  const summaries = roles.map(
    (role) =>
      results.find(
        (row) => row.role === role && row.condition === shownCondition && row.category === "all",
      ) ?? results.find((row) => row.role === role && row.condition === shownCondition),
  );
  return (
    <section
      className="training-benchmark-evidence"
      data-mode={completed ? "inspection" : "benchmarking"}
      aria-label="Paired benchmark evidence"
    >
      <div className="training-evidence-heading">
        <h3>{completed ? "Benchmark complete" : "Comparing models"}</h3>
        <span>
          {!completed
            ? `${{ identity: "Original", brightness_minus30: "Darker", jpeg80: "JPEG", scale60: "Smaller" }[shownCondition ?? ""] ?? shownCondition ?? "Unreported"} condition`
            : ""}
          {benchmark?.pass && !completed ? ` · ${benchmark.pass} pass` : ""}
          {benchmark?.processed != null && !completed
            ? ` · ${number(benchmark.processed)}${benchmark.total == null ? "" : ` / ${number(benchmark.total)}`}`
            : ""}
        </span>
      </div>
      {completed && !summaries.some(Boolean) && run.benchmark && (
        <div className="training-combined-score" aria-label="Combined benchmark result">
          <strong>{rate(run.benchmark.exact_match)}</strong>
          <span>Combined exact match</span>
          <span>Baseline {rate(run.benchmark.baseline_exact_match)}</span>
          <span>
            {number(run.benchmark.regressions)} regressions · {number(run.benchmark.improved)}{" "}
            improvements
          </span>
        </div>
      )}
      <div className="training-evidence-controls" hidden={!completed}>
        {completed && (
          <div role="group" aria-label="Benchmark case outcome">
            {[
              ["all", "All examples"],
              ["regressed", "Regressions"],
              ["improved", "Improvements"],
            ].map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant="ghost"
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value!);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        {completed && conditions.length > 1 && (
          <label>
            Condition
            <NativeSelect
              aria-label="Result condition"
              value={shownCondition}
              onChange={(event) => {
                if (onEvidenceConditionChange) onEvidenceConditionChange(event.target.value);
                else setCondition(event.target.value);
              }}
            >
              {conditions.map((value) => (
                <NativeSelectOption value={value} key={value}>
                  {{
                    identity: "Original",
                    brightness_minus30: "Darker",
                    jpeg80: "JPEG",
                    scale60: "Smaller",
                  }[value] ?? value}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
      </div>
      <div className="training-pair-lanes">
        {roles.map((role, index) => (
          <RoleEvidence
            key={`${role}:${shownCondition}:${filter}`}
            role={role}
            cases={cases.filter((row) => row.role === role)}
            result={summaries[index]}
            completed={completed}
          />
        ))}
      </div>
    </section>
  );
}
function CompletedResults({
  run,
  telemetry,
  evidenceCondition,
  onEvidenceConditionChange,
  onCompareConditions,
}: {
  run: PokerTrainingRun;
  telemetry: PokerTrainingTelemetry | undefined;
  evidenceCondition: string | undefined;
  onEvidenceConditionChange: ((value: string) => void) | undefined;
  onCompareConditions: (() => void) | undefined;
}) {
  const [inspection, setInspection] = useState<"regressed" | "improved" | "conditions" | null>(
    null,
  );
  const results = run.benchmark?.results ?? [];
  const identity = roles.map((role) =>
    results.find(
      (row) => row.role === role && row.condition === "identity" && row.category === "all",
    ),
  );
  const names = identity[1];
  const total = run.benchmark?.samples ?? run.summary?.test ?? run.analysis?.test;
  const sum = (field: "regressions" | "improved") =>
    identity.every((row) => row?.[field] != null)
      ? identity.reduce((value, row) => value + row![field]!, 0)
      : run.benchmark?.[field];
  const conditions = new Set(results.map((row) => row.condition)).size;
  return (
    <section className="training-completed-results" aria-label="Completed benchmark results">
      <div className="training-results-heading">
        <h3>Benchmark complete</h3>
        <span>
          {total == null ? "Held-out count unavailable" : `${number(total)} held-out crops`}
        </span>
      </div>
      <div className="training-result-pair">
        {roles.map((role, index) => (
          <Card key={role} className="training-result-card" size="sm">
            <CardContent>
              <section aria-label={`${roleName(role)} results`}>
                <h4>{roleName(role)}</h4>
                <div className="training-result-score">{rate(identity[index]?.exact_match)}</div>
                <p>
                  {identity[index]
                    ? `${number(identity[index].regressions)} ${identity[index].regressions === 1 ? "regression" : "regressions"} · ${number(identity[index].improved)} ${identity[index].improved === 1 ? "improvement" : "improvements"}`
                    : "Per-model score unavailable"}
                </p>
              </section>
            </CardContent>
          </Card>
        ))}
      </div>
      {!identity.some(Boolean) && run.benchmark && (
        <div className="training-combined-score" aria-label="Combined benchmark result">
          <strong>{rate(run.benchmark.exact_match)}</strong>
          <span>Combined exact match · Baseline {rate(run.benchmark.baseline_exact_match)}</span>
        </div>
      )}
      {names?.baseline_exact_match != null ? (
        <section className="training-result-bars" aria-label="Baseline versus Names exact match">
          {[
            ["Baseline", names.baseline_exact_match],
            ["Names", names.exact_match],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <span>{label}</span>
              <div className="training-result-bar-track">
                <span
                  className={
                    label === "Names"
                      ? "training-result-bar-candidate"
                      : "training-result-bar-baseline"
                  }
                  style={{ width: `${Number(value) * 100}%` }}
                />
              </div>
              <span>{rate(Number(value))}</span>
            </div>
          ))}
        </section>
      ) : (
        <p className="training-result-comparison-missing">
          Baseline versus Names comparison unavailable.
        </p>
      )}
      <div className="training-result-actions">
        <Button
          variant="ghost"
          onClick={() => {
            setInspection("regressed");
          }}
        >
          <span>Review regressions</span>
          <strong className="training-result-negative">{number(sum("regressions"))}</strong>
          <RiArrowRightLine aria-hidden="true" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setInspection("improved");
          }}
        >
          <span>Inspect improvements</span>
          <strong className="training-result-positive">{number(sum("improved"))}</strong>
          <RiArrowRightLine aria-hidden="true" className="size-4" />
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (onCompareConditions) onCompareConditions();
            else setInspection("conditions");
          }}
        >
          <span>Compare stress conditions</span>
          <strong>{conditions || "—"}</strong>
          <RiArrowRightLine aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <Dialog
        open={inspection !== null}
        onOpenChange={(open) => {
          if (!open) setInspection(null);
        }}
      >
        <DialogContent className="training-evidence-dialog">
          <DialogHeader>
            <DialogTitle>
              {inspection === "regressed"
                ? "Review regressions"
                : inspection === "improved"
                  ? "Inspect improvements"
                  : "Compare stress conditions"}
            </DialogTitle>
            <DialogDescription>
              Retained paired predictions from the frozen benchmark.
            </DialogDescription>
          </DialogHeader>
          {inspection && (
            <BenchmarkEvidence
              key={inspection}
              run={run}
              telemetry={telemetry}
              evidenceCondition={evidenceCondition}
              onEvidenceConditionChange={onEvidenceConditionChange}
              initialFilter={inspection === "conditions" ? "all" : inspection}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
export function TrainingActivity({
  run,
  workers,
  telemetry,
  evidenceCondition,
  onEvidenceConditionChange,
  onCompareConditions,
}: {
  onCompareConditions?: (() => void) | undefined;
  run: PokerTrainingRun;
  workers: PokerTrainingWorker[];
  telemetry: PokerTrainingTelemetry | undefined;
  evidenceCondition?: string | undefined;
  onEvidenceConditionChange?: ((value: string) => void) | undefined;
}) {
  if (run.status === "queued" || run.status === "preparing") {
    const progress = run.data_progress;
    const collectionMetadata = run.analysis?.collections ?? [];
    return (
      <section className="training-preparation" aria-label="Data preparation">
        <div className="training-scene-heading">
          <h3>Preparing collections</h3>
          <span>Collection samples</span>
        </div>
        {run.collections.map((id) => {
          const collection = collectionMetadata.find((item) => item.id === id);
          const samples = (telemetry?.samples ?? [])
            .filter((sample) => sample.collection_id === id)
            .slice(0, 4);
          return (
            <section
              className="training-collection-row"
              aria-label={`${collection?.name ?? id} preparation samples`}
              key={id}
            >
              <strong>{collection?.name ?? id}</strong>
              <span>
                {collection?.eligible == null
                  ? "Eligible count unavailable"
                  : `${number(collection.eligible)} eligible`}
              </span>
              {samples.length ? (
                <div className="training-corpus-previews">
                  {samples.map((sample) => (
                    <figure key={sample.sample_id}>
                      {sample.image_url ? (
                        <img
                          src={mediaUrl(sample.image_url)}
                          alt={`Dataset example: ${sample.label}`}
                          loading="lazy"
                        />
                      ) : (
                        <span>Crop unavailable</span>
                      )}
                    </figure>
                  ))}
                </div>
              ) : (
                <p className="training-collection-missing">
                  Collection previews unavailable for this version.
                </p>
              )}
            </section>
          );
        })}
        {!run.collections.length && (
          <p className="training-telemetry-empty">
            Selected collections not recorded for this version.
          </p>
        )}
        <div className="training-preparation-checks" aria-label="Preparation stages">
          {[
            ["reading", "Read captures"],
            ["validating", "Validate crops"],
            ["deduplicating", "Deduplicate"],
            ["reserving", "Reserve benchmark"],
          ].map(([id, label], index) => {
            const stages = ["reading", "validating", "deduplicating", "reserving", "ready"];
            const current = progress ? stages.indexOf(progress.stage) : -1;
            return (
              <span
                key={id}
                data-state={current > index ? "complete" : current === index ? "active" : "pending"}
              >
                {current > index ? "✓ " : ""}
                {label}
              </span>
            );
          })}
        </div>
      </section>
    );
  }
  if (run.status === "completed")
    return (
      <CompletedResults
        run={run}
        telemetry={telemetry}
        evidenceCondition={evidenceCondition}
        onEvidenceConditionChange={onEvidenceConditionChange}
        onCompareConditions={onCompareConditions}
      />
    );
  if (
    run.status === "benchmarking" ||
    (/benchmark/i.test(run.stage) && ["failed", "interrupted"].includes(run.status))
  )
    return (
      <BenchmarkEvidence
        telemetry={telemetry}
        run={run}
        evidenceCondition={evidenceCondition}
        onEvidenceConditionChange={onEvidenceConditionChange}
      />
    );
  return (
    <section className="training-job-lanes" aria-label="Training workers">
      <div className="training-scene-heading">
        <h3>Training models</h3>
        <span>{/export|parity|transfer/i.test(run.stage) ? run.stage : "Independent jobs"}</span>
      </div>
      {roles.map((role) => (
        <WorkerLane
          key={role}
          role={role}
          worker={workers.find((worker) => worker.role === role)}
          histories={telemetry?.histories ?? []}
          baseActive={workers.some(
            (item) => item.stage_id === "base" && ["initializing", "training"].includes(item.state),
          )}
          baseComplete={workers.some(
            (item) =>
              item.role === "general" &&
              (item.stage_id === "general" ||
                (item.stage_id === "base" && item.state === "completed")),
          )}
        />
      ))}
      {workers.some((worker) => worker.stage_id) && (
        <div className="training-phase-strip" aria-label="Recorded phase sequence">
          <span data-complete={run.data_progress?.stage === "ready"}>
            {run.data_progress?.stage === "ready" ? "✓ " : ""}Data
          </span>
          <span>→</span>
          <span
            data-complete={workers.some(
              (worker) => worker.stage_id === "general" || worker.stage_id === "names",
            )}
          >
            {workers.some((worker) => worker.stage_id === "general" || worker.stage_id === "names")
              ? "✓ "
              : ""}
            Shared base
          </span>
          <span>→</span>
          <span>General + Names</span>
          <span>→</span>
          <span>Benchmark</span>
        </div>
      )}
    </section>
  );
}
