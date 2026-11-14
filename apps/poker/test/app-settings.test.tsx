import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppSettings } from "../src/collector/app_settings.js";
import { launcherRequest } from "../src/lib/launcher.js";

vi.mock("../src/lib/launcher.js", () => ({ launcherRequest: vi.fn() }));
const current = { id: "/current", path: "/current", branch: "work/current", head: "a".repeat(40) };
const other = { id: "/other", path: "/other", branch: "work/other", head: "b".repeat(40) };
const config = { configured: true, model: "gpt-4.1" };
function setup({
  failSave = false,
  failActive = false,
  failLoad = false,
  withVersions = false,
  failActivation = false,
  eligible = true,
  baselineBenchmark = false,
} = {}) {
  vi.mocked(launcherRequest).mockResolvedValue({
    selection: "latest",
    current,
    desired: current,
    worktrees: [current, other],
    error: null,
  });
  const reply = (value: unknown, ok = true) =>
    Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(value) });
  const request = vi.fn((path: string, options?: RequestInit) => {
    if (path === "/api/training/versions")
      return reply(
        failActive
          ? { error: "OCR release unavailable" }
          : {
              versions: withVersions
                ? [
                    {
                      id: "baseline",
                      display_name: "Original release",
                      created_at: 0,
                      active: true,
                      eligible: true,
                      regressions: 0,
                      improved: 0,
                      ...(baselineBenchmark
                        ? {
                            benchmark: {
                              exact_match: 0.98,
                              cer: 0.02,
                              p95_ms: 10,
                              samples: 100,
                              processing_errors: 0,
                            },
                          }
                        : {}),
                    },
                    {
                      id: "candidate",
                      display_name: "Version 5",
                      created_at: 10,
                      active: false,
                      eligible,
                      reason: eligible ? null : "Benchmark test set is outdated",
                      regressions: 2,
                      improved: 4,
                      benchmark: {
                        exact_match: 0.99,
                        cer: 0.01,
                        p95_ms: 10,
                        samples: 100,
                        baseline_exact_match: 0.98,
                        processing_errors: 0,
                      },
                    },
                  ]
                : [],
              active_release: {
                ...(withVersions ? { id: "baseline", display_name: "Original release" } : {}),
                name: "Qualified release",
                path: "/models/current",
                general_sha256: "a".repeat(64),
                names_sha256: "b".repeat(64),
              },
            },
        !failActive,
      );
    if (path === "/api/training/activate")
      return reply(
        failActivation
          ? { error: "Candidate model could not be warmed" }
          : {
              active_release: {
                configured: true,
                id: "candidate",
                display_name: "Version 5",
                general_sha256: "c".repeat(64),
                names_sha256: "d".repeat(64),
              },
            },
        !failActivation,
      );
    const body =
      typeof options?.body === "string" ? (JSON.parse(options.body) as { model: string }) : null;
    return reply(
      failLoad && !body
        ? { error: "OpenAI settings file is invalid" }
        : failSave && body
          ? { error: "Could not save settings" }
          : { ...config, ...(body ? { model: body.model } : {}), api_key: "NEVER-ECHO-THIS" },
      !(failSave && body) && !(failLoad && !body),
    );
  });
  vi.stubGlobal("fetch", request);
  return request;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(launcherRequest).mockReset();
});

it("opens global settings with checkout and active model fingerprints, without disclosures", async () => {
  const request = setup();
  render(<AppSettings collapsed={false} />);
  expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("w-full", "justify-start");
  expect(screen.getByRole("button", { name: "Settings" }).parentElement).toHaveClass(
    "w-full",
    "min-w-0",
    "pr-2",
  );
  expect(screen.queryByRole("combobox", { name: "Checkout" })).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1"));
  expect(dialog.querySelector("details")).toBeNull();
  expect(within(dialog).getByText("a".repeat(12))).toBeInTheDocument();
  expect(within(dialog).getByText("b".repeat(12))).toBeInTheDocument();
  expect(within(dialog).getByText("a".repeat(12))).toHaveAttribute("title", "a".repeat(64));
  expect(dialog).not.toHaveTextContent("/models/current");
  expect(dialog).not.toHaveTextContent("NEVER-ECHO-THIS");
  const checkout = within(dialog).getByRole("combobox", { name: "Checkout" });
  fireEvent.keyDown(checkout, { key: "ArrowDown" });
  const branch = await screen.findByRole("option", { name: "work/other" });
  vi.mocked(launcherRequest).mockResolvedValue({
    selection: other.id,
    current,
    desired: other,
    worktrees: [current, other],
    error: null,
  });
  fireEvent.click(branch);
  await waitFor(() => {
    expect(launcherRequest).toHaveBeenLastCalledWith("select", "/other");
  });
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    "/api/ai-review/config",
    "/api/training/versions",
  ]);
});

it("saves model changes with an existing key without sending a blank key or using browser storage", async () => {
  const request = setup();
  const changed = vi.fn();
  window.addEventListener("poker-ai-settings-change", changed);
  render(<AppSettings collapsed />);
  expect(screen.getByRole("button", { name: "Settings" })).toHaveClass("size-9");
  expect(screen.getByRole("button", { name: "Settings" }).parentElement).toHaveClass("w-9");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await waitFor(() =>
    expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "Saved key"),
  );
  expect(screen.getByLabelText("API key")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4.1-mini" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(JSON.parse(request.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
    model: "gpt-4.1-mini",
  });
  expect(request.mock.calls.at(-1)?.[1]?.headers).toEqual({ "Content-Type": "application/json" });
  expect(changed).toHaveBeenCalledOnce();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  window.removeEventListener("poker-ai-settings-change", changed);
});

it("preserves a key after a failed save and clears it only after a successful retry", async () => {
  const request = setup({ failSave: true });
  render(<AppSettings collapsed={false} />);
  window.dispatchEvent(new Event("poker-open-settings"));
  await waitFor(() => expect(screen.getByLabelText("API key")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-OnlyInPasswordField" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("API key")).toHaveValue("sk-OnlyInPasswordField");
  request.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(config) });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText("Saved");
  expect(screen.getByLabelText("API key")).toHaveValue("");
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps OpenAI settings usable when the active release cannot be read", async () => {
  setup({ failActive: true });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("OCR release unavailable");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
});

it("shows an unconfigured active release and its error without inventing model fingerprints", async () => {
  const request = setup();
  request.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(config) });
  request.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        versions: [],
        active_release: {
          configured: false,
          error: "Active release is missing",
          general_sha256: null,
          names_sha256: null,
        },
      }),
  });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("No active release");
  expect(screen.getByRole("alert")).toHaveTextContent("Active release is missing");
  expect(screen.queryByText("General")).not.toBeInTheDocument();
});

it("repairs a failed configuration read with an explicit replacement key and model", async () => {
  const request = setup({ failLoad: true });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("OpenAI settings file is invalid");
  expect(screen.getByLabelText("API key")).toBeEnabled();
  expect(screen.getByLabelText("API key")).toHaveAttribute("placeholder", "sk-…");
  expect(screen.getByLabelText("Model")).toHaveValue("gpt-4.1");
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-ExplicitReplacement" },
  });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-4.1-mini" } });
  expect(screen.getByRole("alert")).toHaveTextContent("OpenAI settings file is invalid");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent("OpenAI settings file is invalid");
  await screen.findByText("Saved");
  expect(JSON.parse(request.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
    model: "gpt-4.1-mini",
    api_key: "sk-ExplicitReplacement",
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByLabelText("API key")).toHaveValue("");
});

it("activates a selected whole version with visible regression counts and updates both model fingerprints", async () => {
  const request = setup({ withVersions: true });
  const changed = vi.fn();
  window.addEventListener("poker-ocr-models-change", changed);
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByLabelText("Version");
  expect(screen.getByRole("button", { name: "Use version" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Version" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /^Version 5/ }));
  expect(screen.getByText("2 regressions · 4 improvements vs original")).toBeInTheDocument();
  expect(screen.getByText("99.00% exact · 100 samples")).toBeInTheDocument();
  expect(request.mock.calls.some(([path]) => path === "/api/training/activate")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Use version" }));
  await screen.findByText("c".repeat(12));
  expect(screen.getByText("d".repeat(12))).toHaveAttribute("title", "d".repeat(64));
  expect(JSON.parse(request.mock.calls.at(-1)?.[1]?.body as string)).toEqual({
    id: "candidate",
    acknowledge_regressions: true,
  });
  expect(screen.getByRole("button", { name: "Use version" })).toBeDisabled();
  expect(changed).toHaveBeenCalledOnce();
  window.removeEventListener("poker-ocr-models-change", changed);
});

it("keeps the current version and selection when activation fails", async () => {
  setup({ withVersions: true, failActivation: true });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByLabelText("Version");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Version" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /^Version 5/ }));
  fireEvent.click(screen.getByRole("button", { name: "Use version" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Candidate model could not be warmed");
  expect(screen.getByText("a".repeat(12))).toBeInTheDocument();
  expect(screen.getByText("b".repeat(12))).toBeInTheDocument();
  expect(screen.queryByText("c".repeat(12))).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Version" })).toHaveTextContent("Version 5");
  expect(screen.getByRole("button", { name: "Use version" })).toBeEnabled();
});

it("shows benchmark ineligibility and prevents activation", async () => {
  const request = setup({ withVersions: true, eligible: false });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByLabelText("Version");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Version" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: /^Version 5/ }));
  expect(screen.getByText("Benchmark test set is outdated")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use version" })).toBeDisabled();
  expect(request.mock.calls.some(([path]) => path === "/api/training/activate")).toBe(false);
});

it("shows measured original-release benchmark results without a fabricated comparison", async () => {
  setup({ withVersions: true, baselineBenchmark: true });
  render(<AppSettings collapsed={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByLabelText("Version");
  expect(screen.getByText("98.00% exact · 100 samples")).toBeInTheDocument();
  expect(screen.queryByText(/regressions/)).not.toBeInTheDocument();
});
