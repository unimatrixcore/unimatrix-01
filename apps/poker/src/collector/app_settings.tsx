import { useEffect, useRef, useState } from "react";
import { RiSettings3Line } from "@remixicon/react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@unimatrix/ui";
import {
  pokerAiReviewConfigSchema,
  pokerTrainingActiveSchema,
  pokerTrainingVersionsSchema,
} from "@unimatrix/shared";
import { BranchSelector } from "./branch_selector";
import "./app_settings.css";

type AiConfig = ReturnType<typeof pokerAiReviewConfigSchema.parse>;
type ActiveRelease = ReturnType<typeof pokerTrainingActiveSchema.parse>["active_release"];
type ModelVersion = ReturnType<typeof pokerTrainingVersionsSchema.parse>["versions"][number];
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
async function settingsRequest(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(path, options);
  const value: unknown = await response.json();
  if (
    !response.ok ||
    (value && typeof value === "object" && "success" in value && value.success === false)
  ) {
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Request failed (${response.status})`,
    );
  }
  return value;
}

export function AppSettings({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [model, setModel] = useState("gpt-4.1");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [active, setActive] = useState<ActiveRelease | undefined>(undefined);
  const [activeError, setActiveError] = useState("");
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [versionId, setVersionId] = useState("");
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState("");
  const selectedVersion = versions.find((version) => version.id === versionId);
  const generation = useRef(0);
  useEffect(() => {
    const show = () => {
      setOpen(true);
    };
    window.addEventListener("poker-open-settings", show);
    return () => {
      window.removeEventListener("poker-open-settings", show);
    };
  }, []);
  useEffect(() => {
    generation.current++;
    if (!open) {
      setKey("");
      return;
    }
    const controller = new AbortController();
    setConfig(null);
    setLoading(true);
    setModel("gpt-4.1");
    setError("");
    setSaved(false);
    setActive(undefined);
    setActiveError("");
    setVersions([]);
    setVersionId("");
    setActivationError("");
    void settingsRequest("/api/ai-review/config", { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted) return;
        const next = pokerAiReviewConfigSchema.parse(value);
        setConfig(next);
        setModel(next.model);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(failure(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    void settingsRequest("/api/training/versions", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) {
          const next = pokerTrainingVersionsSchema.parse(value);
          setActive(next.active_release);
          setVersions(next.versions);
          setVersionId(next.versions.find((version) => version.active)?.id || "");
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setActiveError(failure(reason));
      });
    return () => {
      controller.abort();
    };
  }, [open]);
  async function save() {
    if (saving || loading || !model.trim()) return;
    const current = generation.current;
    setSaving(true);
    setSaved(false);
    try {
      const next = pokerAiReviewConfigSchema.parse(
        await settingsRequest("/api/ai-review/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: model.trim(),
            ...(key.trim() ? { api_key: key.trim() } : {}),
          }),
        }),
      );
      window.dispatchEvent(new Event("poker-ai-settings-change"));
      if (current === generation.current) {
        setError("");
        setConfig(next);
        setModel(next.model);
        setKey("");
        setSaved(true);
      }
    } catch (reason) {
      if (current === generation.current) setError(failure(reason));
    } finally {
      setSaving(false);
    }
  }
  async function activate() {
    if (activating || !selectedVersion?.eligible || selectedVersion.active) return;
    const current = generation.current;
    setActivating(true);
    setActivationError("");
    try {
      const next = pokerTrainingActiveSchema.parse(
        await settingsRequest("/api/training/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: selectedVersion.id,
            ...(selectedVersion.regressions > 0 ? { acknowledge_regressions: true } : {}),
          }),
        }),
      );
      if (!next.active_release || next.active_release.configured === false)
        throw new Error(next.active_release?.error || "Version activation failed");
      window.dispatchEvent(new Event("poker-ocr-models-change"));
      if (current === generation.current) {
        setActive(next.active_release);
        setVersions((previous) =>
          previous.map((version) => ({ ...version, active: version.id === selectedVersion.id })),
        );
      }
    } catch (reason) {
      if (current === generation.current) setActivationError(failure(reason));
    } finally {
      setActivating(false);
    }
  }
  return (
    <div data-poker-settings-control className={collapsed ? "w-9" : "w-full min-w-0 pr-2"}>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) window.dispatchEvent(new Event("poker-open-settings"));
        }}
      >
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size={collapsed ? "icon" : "sm"}
            className={collapsed ? "size-9" : "w-full justify-start"}
            aria-label="Settings"
            title="Settings"
          >
            <RiSettings3Line className="size-4 shrink-0" aria-hidden="true" />
            {!collapsed && <span className="truncate">Settings</span>}
          </Button>
        </DialogTrigger>
        <DialogContent className="poker-app-settings" aria-describedby={undefined}>
          <DialogTitle>Settings</DialogTitle>
          <section className="app-settings-checkout" aria-label="Checkout">
            <h3>Checkout</h3>
            <BranchSelector />
          </section>
          <section aria-labelledby="app-settings-openai">
            <h3 id="app-settings-openai">OpenAI</h3>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label htmlFor="app-settings-key">API key</label>
              <Input
                id="app-settings-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                placeholder={config?.configured ? "Saved key" : "sk-…"}
                disabled={loading || saving}
                onChange={(event) => {
                  setKey(event.target.value);
                  setSaved(false);
                }}
              />
              <label htmlFor="app-settings-model">Model</label>
              <Input
                id="app-settings-model"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                value={model}
                disabled={loading || saving}
                onChange={(event) => {
                  setModel(event.target.value);
                  setSaved(false);
                }}
              />
              <div className="app-settings-save">
                <span role="status">
                  {saving
                    ? "Saving…"
                    : saved
                      ? "Saved"
                      : config
                        ? config.configured
                          ? "Key configured"
                          : "API key needed"
                        : error
                          ? ""
                          : "Loading…"}
                </span>
                <Button type="submit" size="sm" disabled={loading || saving || !model.trim()}>
                  Save
                </Button>
              </div>
              {error && (
                <p className="app-settings-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          </section>
          <section aria-labelledby="app-settings-ocr">
            <h3 id="app-settings-ocr">Active OCR models</h3>
            {activeError ? (
              <p className="app-settings-error" role="alert">
                {activeError}
              </p>
            ) : active === undefined ? (
              <span role="status">Loading…</span>
            ) : active && active.configured !== false ? (
              <>
                {(active.display_name || active.name) && (
                  <div className="app-settings-release" title={active.path}>
                    {active.display_name || active.name}
                  </div>
                )}
                <dl>
                  {(
                    [
                      ["General", active.general_sha256],
                      ["Names", active.names_sha256],
                    ] as const
                  ).map(([role, hash]) => (
                    <div key={role}>
                      <dt>{role}</dt>
                      <dd title={hash || undefined}>{hash ? hash.slice(0, 12) : "Unavailable"}</dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <>
                <span>No active release</span>
                {active?.error && (
                  <p className="app-settings-error" role="alert">
                    {active.error}
                  </p>
                )}
              </>
            )}
            {versions.length > 0 && (
              <div className="app-settings-version">
                <label htmlFor="app-settings-version">Version</label>
                <div className="app-settings-version-picker">
                  <Select
                    value={versionId}
                    disabled={activating}
                    onValueChange={(value) => {
                      setVersionId(value);
                      setActivationError("");
                    }}
                  >
                    <SelectTrigger id="app-settings-version" aria-label="Version">
                      <SelectValue placeholder="Select version" />
                    </SelectTrigger>
                    <SelectContent
                      position="popper"
                      align="start"
                      className="app-settings-select-menu"
                    >
                      {versions.map((version) => (
                        <SelectItem key={version.id} value={version.id}>
                          {version.display_name}
                          {version.eligible ? "" : " (unavailable)"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    disabled={activating || !selectedVersion?.eligible || selectedVersion.active}
                    onClick={() => {
                      void activate();
                    }}
                  >
                    {activating ? "Switching…" : "Use version"}
                  </Button>
                </div>
                {selectedVersion && (
                  <div className="app-settings-version-status">
                    {selectedVersion.benchmark ? (
                      <>
                        <div>
                          {(selectedVersion.benchmark.exact_match * 100).toFixed(2)}% exact
                          {typeof selectedVersion.benchmark.samples === "number" &&
                            ` · ${selectedVersion.benchmark.samples.toLocaleString()} samples`}
                        </div>
                        {selectedVersion.id !== "baseline" && (
                          <div>
                            {selectedVersion.regressions.toLocaleString()} regressions ·{" "}
                            {selectedVersion.improved.toLocaleString()} improvements vs original
                          </div>
                        )}
                        {!!selectedVersion.benchmark.processing_errors && (
                          <div className="app-settings-error">
                            {selectedVersion.benchmark.processing_errors.toLocaleString()}{" "}
                            processing errors
                          </div>
                        )}
                      </>
                    ) : (
                      <div>Benchmark unavailable</div>
                    )}
                    {selectedVersion.reason && <div>{selectedVersion.reason}</div>}
                  </div>
                )}
              </div>
            )}
            {activationError && (
              <p className="app-settings-error" role="alert">
                {activationError}
              </p>
            )}
          </section>
        </DialogContent>
      </Dialog>
    </div>
  );
}
