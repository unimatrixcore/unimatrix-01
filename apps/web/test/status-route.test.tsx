import { render, screen } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
} from "@tanstack/react-router";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { Providers } from "@/app/providers";
import { createAppRouter } from "@/app/router";
import { createAppQueryClient } from "@/lib/query-client";

describe("about route", () => {
  it("renders the /about route with contact details and an email draft form", async () => {
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
    expect(screen.getByRole("link", { name: /open email draft/i })).toBeInTheDocument();
  });
});
