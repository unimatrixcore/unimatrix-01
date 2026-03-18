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

describe("about route", () => {
  beforeEach(() => {
    getHealthMock.mockReset();
  });

  it("renders the /about route with contact details and a subtle system check", async () => {
    getHealthMock.mockResolvedValue({
      service: "api",
      status: "ok",
    });

    const queryClient = createAppQueryClient();
    const router = createAppRouter({
      history: createMemoryHistory({
        initialEntries: ["/about"],
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
      await screen.findByText(
        "Draft an email",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("gwen.phalan@gmail.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});
