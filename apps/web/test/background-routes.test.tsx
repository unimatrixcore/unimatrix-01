import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ApiClientError, type ApiClientRequestControl } from "@unimatrix/api-client";
import type { ContentPostSummary, ListPostsQuery, ListPostsResponse } from "@unimatrix/shared";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listPosts } = vi.hoisted(() => ({
  listPosts:
    vi.fn<
      (query: ListPostsQuery, control?: ApiClientRequestControl) => Promise<ListPostsResponse>
    >(),
}));
vi.mock("@/lib/api-client", () => ({ apiClient: { listPosts } }));

import { Providers } from "@/app/providers";
import { createAppRouter } from "@/app/router";
import { createAppQueryClient } from "@/lib/query-client";

function post(type: "blog" | "project", slug: string): ContentPostSummary {
  return {
    id: `00000000-0000-4000-8000-${slug === "first" ? "000000000001" : "000000000002"}`,
    type,
    slug,
    title: slug === "first" ? "First record" : "Featured record",
    summary: "Summary",
    description: null,
    publicationState: "published",
    publishedAt: "2026-11-01",
    featured: slug !== "first",
    projectStatus: null,
    repoUrl: "https://example.test/repo",
    liveUrl: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

async function renderRoute(path: string) {
  const queryClient = createAppQueryClient();
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    queryClient,
  });
  const view = render(
    <Providers client={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await act(async () => {
    await router.load();
  });
  return { ...view, router, queryClient };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(220);
  listPosts.mockReset().mockImplementation((query: ListPostsQuery) =>
    Promise.resolve({
      posts: [post(query.type, query.featured === "true" ? "featured" : "first")],
      nextCursor: null,
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("background content routes", () => {
  it("subscribes to later blog pages and keeps cached rows when returning", async () => {
    listPosts.mockImplementation((query: ListPostsQuery) =>
      Promise.resolve({
        posts: [post(query.type, query.cursor ? "featured" : "first")],
        nextCursor: query.cursor ? null : JSON.stringify(["2026-11-01", "first"]),
      }),
    );
    const { router, queryClient } = await renderRoute("/blog");
    expect(await screen.findByRole("heading", { name: "First record" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Featured record" })).toBeInTheDocument();
    await act(async () => {
      await router.navigate({ to: "/about" });
    });
    const calls = listPosts.mock.calls.length;
    await act(async () => {
      await router.navigate({ to: "/blog" });
    });
    expect(await screen.findByRole("heading", { name: "Featured record" })).toBeInTheDocument();
    expect(listPosts).toHaveBeenCalledTimes(calls);
    queryClient.clear();
  });

  it("loads featured projects at the server boundary and renders project actions", async () => {
    const { router, queryClient } = await renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Featured record" })).toBeInTheDocument();
    expect(
      listPosts.mock.calls.some(([query]) => query.type === "project" && query.featured === "true"),
    ).toBe(true);
    await act(async () => {
      await router.navigate({ to: "/projects" });
    });
    expect(await screen.findByRole("heading", { name: "First record" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open repository/ })).toBeInTheDocument();
    queryClient.clear();
  });

  it("preserves a partial catalog and lets the user retry a failed continuation", async () => {
    let fail = true;
    listPosts.mockImplementation((query: ListPostsQuery) => {
      if (query.cursor && fail)
        return Promise.reject(new ApiClientError("Busy", { status: 503, retryAfterMs: 0 }));
      return Promise.resolve({
        posts: [post("blog", query.cursor ? "featured" : "first")],
        nextCursor: query.cursor ? null : JSON.stringify(["2026-11-01", "first"]),
      });
    });
    const { queryClient } = await renderRoute("/blog");
    expect(await screen.findByRole("heading", { name: "First record" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load more.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Featured record" })).toBeInTheDocument();
    queryClient.clear();
  });
});
