import { render, screen } from "@testing-library/react";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Providers } from "@/app/providers";
import { createAppRouter } from "@/app/router";
import { completeStatusHistory } from "@/features/status/public-status-page";
import { createAppQueryClient } from "@/lib/query-client";

const { request, listPosts } = vi.hoisted(() => ({ request: vi.fn(), listPosts: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ apiClient: { request, listPosts } }));
afterEach(() => {
  vi.resetAllMocks();
});

async function renderStatus(hostname = "localhost", path = "/status") {
  const queryClient = createAppQueryClient();
  const router = createAppRouter({
    hostname,
    queryClient,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await act(async () => {
    await router.load();
  });
  return router;
}

describe("public deployment status", () => {
  it("renders the status shell while the status request is still pending", async () => {
    request.mockReturnValue(new Promise(() => {}));
    await renderStatus();
    expect(await screen.findByRole("heading", { name: "Unimatrix Status" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Checking services" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refreshing status" })).toBeDisabled();
  });

  it("redirects the status hostname root before loading homepage content", async () => {
    request.mockResolvedValue({
      apps: [
        {
          displayName: "API",
          state: "up",
          lastCheckedAt: null,
          history: [],
          summary: { uptimePercent: null, coveragePercent: 0 },
        },
      ],
    });
    const router = await renderStatus("status.unimatrix-01.dev", "/");
    expect(await screen.findByRole("heading", { name: "Unimatrix Status" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/status");
    expect(listPosts).not.toHaveBeenCalled();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /No observations/ })).toHaveLength(30);
    expect(screen.getByRole("contentinfo")).toHaveTextContent(/©.*Gwen Phalan/);
  });

  it("keeps unavailable reads out of the healthy state", async () => {
    request.mockRejectedValue(new Error("private upstream diagnostics"));
    await renderStatus();
    expect(await screen.findByRole("heading", { name: "Status unavailable" })).toBeInTheDocument();
    expect(screen.queryByText(/private upstream/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Services" })).not.toBeInTheDocument();
  });

  it("does not redirect a lookalike hostname", async () => {
    listPosts.mockResolvedValue({ posts: [] });
    const router = await renderStatus("status.unimatrix-01.dev.example.com", "/");
    expect(router.state.location.pathname).toBe("/");
    expect(request).not.toHaveBeenCalled();
    expect(listPosts).toHaveBeenCalled();
  });

  it("pads missing days as unknown and drops history outside the displayed UTC window", () => {
    const today = Date.UTC(2026, 9, 30);
    const observed = { from: today, to: today + 60_000, uptimePercent: 100, coveragePercent: 100 };
    const days = completeStatusHistory([{ ...observed, from: 0 }, observed], today + 60_000);
    expect(days).toHaveLength(30);
    expect(days[0]?.from).toBe(Date.UTC(2026, 9, 1));
    expect(days[0]?.uptimePercent).toBeNull();
    expect(days[29]).toEqual(observed);
  });
});
