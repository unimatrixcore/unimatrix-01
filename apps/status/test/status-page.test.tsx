import { render, screen } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Providers } from "@/app/providers";
import { createAppRouter } from "@/app/router";
import { completeStatusHistory } from "@/features/status/public-status-page";
import { createAppQueryClient } from "@/lib/query-client";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: { request } }));
afterEach(() => {
  vi.resetAllMocks();
});

async function renderStatus() {
  const queryClient = createAppQueryClient();
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createAppRouter({ queryClient, history });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await act(async () => {
    await router.load();
  });
  return { router, history };
}

function response(state: "up" | "down" | "degraded" = "up") {
  return {
    apps: [
      {
        displayName: "API",
        state,
        lastCheckedAt: null,
        history: [],
        summary: { uptimePercent: null, coveragePercent: 0 },
      },
    ],
  };
}

describe("status root", () => {
  it("renders at / without redirecting or adding site navigation", async () => {
    request.mockResolvedValue(response());
    const { history, router } = await renderStatus();
    expect(await screen.findByRole("heading", { name: "Unimatrix Status" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(history.location.pathname).toBe("/");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /No observations/ })).toHaveLength(30);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/©.*Gwen Phalan/);
    expect(screen.queryByRole("link", { name: /Main site/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Gwen Phalan/ })).toHaveAttribute(
      "href",
      "https://unimatrix-01.dev",
    );
  });

  it("shows the shell immediately while the status read is pending", async () => {
    request.mockReturnValue(new Promise(() => {}));
    await renderStatus();
    expect(await screen.findByRole("heading", { name: "Unimatrix Status" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Checking services" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing status" })).toBeDisabled();
  });

  it.each([
    ["up", "All services operational"],
    ["down", "Some services unavailable"],
    ["degraded", "Some services degraded"],
  ] as const)("renders the %s state", async (state, heading) => {
    request.mockResolvedValue(response(state));
    await renderStatus();
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });

  it("does not infer healthy status from an empty service list", async () => {
    request.mockResolvedValue({ apps: [] });
    await renderStatus();
    expect(
      await screen.findByRole("heading", { name: "No published services" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Services" })).not.toBeInTheDocument();
  });

  it("keeps failed reads out of the healthy state without exposing upstream errors", async () => {
    request.mockRejectedValue(new Error("private upstream diagnostics"));
    await renderStatus();
    expect(await screen.findByRole("heading", { name: "Status unavailable" })).toBeInTheDocument();
    expect(screen.queryByText(/private upstream/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Services" })).not.toBeInTheDocument();
  });

  it("pads missing UTC days as unknown and drops data outside the displayed window", () => {
    const today = Date.UTC(2026, 9, 30);
    const observed = { from: today, to: today + 60_000, uptimePercent: 100, coveragePercent: 100 };
    const days = completeStatusHistory([{ ...observed, from: 0 }, observed], today + 60_000);
    expect(days).toHaveLength(30);
    expect(days[0]?.from).toBe(Date.UTC(2026, 9, 1));
    expect(days[0]?.uptimePercent).toBeNull();
    expect(days[29]).toEqual(observed);
  });
});
