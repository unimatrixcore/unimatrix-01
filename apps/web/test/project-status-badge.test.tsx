import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectStatusBadge } from "@/features/public-site/components";

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("ProjectStatusBadge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the static frontmatter status when there is no liveUrl", () => {
    renderWithQueryClient(<ProjectStatusBadge frontmatter={{ status: "standby" }} />);

    expect(screen.getByText("standby")).toBeInTheDocument();
  });

  it("shows a checking state before the live check resolves", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    renderWithQueryClient(
      <ProjectStatusBadge
        frontmatter={{ liveUrl: "https://cube.unimatrix-01.dev", status: "active" }}
      />,
    );

    expect(screen.getByText("Checking")).toBeInTheDocument();
  });

  it("shows Live once the liveUrl check succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({}));

    renderWithQueryClient(
      <ProjectStatusBadge
        frontmatter={{ liveUrl: "https://cube.unimatrix-01.dev", status: "active" }}
      />,
    );

    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  it("shows Offline once the liveUrl check fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderWithQueryClient(
      <ProjectStatusBadge
        frontmatter={{ liveUrl: "https://cube.unimatrix-01.dev", status: "active" }}
      />,
    );

    expect(await screen.findByText("Offline")).toBeInTheDocument();
  });
});
