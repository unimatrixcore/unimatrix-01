import { render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
} from "@tanstack/react-router";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getHealthMock } = vi.hoisted(() => ({
  getHealthMock: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiClient: {
    getHealth: getHealthMock,
  },
}));

import { Providers } from "@/app/providers";
import { createAppRouter } from "@/app/router";
import { createAppQueryClient } from "@/lib/query-client";

describe("status route", () => {
  beforeEach(() => {
    getHealthMock.mockReset();
  });

  it("renders the /status route with query-backed health data", async () => {
    getHealthMock.mockResolvedValue({
      service: "api",
      status: "ok",
    });

    const queryClient = createAppQueryClient();
    const router = createAppRouter({
      history: createMemoryHistory({
        initialEntries: ["/status"],
      }),
      queryClient,
    });

    render(
      <Providers client={queryClient}>
        <RouterProvider router={router} />
      </Providers>,
    );

    await act(async () => {
      await router.load();
    });

    expect(
      await screen.findByText("TanStack Router file-based routing is active."),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "GET /health is fetched through @unimatrix/api-client and parsed with the shared contract.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});
