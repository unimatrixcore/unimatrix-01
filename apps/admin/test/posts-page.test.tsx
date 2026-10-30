import type { ApiClient } from "@unimatrix/api-client";
import type { ContentPostSummary } from "@unimatrix/shared";
import type * as EditorModule from "@unimatrix/ui/editor";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderInRouter } from "./helpers/render-in-router";

const apiClient = {
  adminListPosts: vi.fn(),
  adminGetPost: vi.fn(),
  setPostsState: vi.fn(),
  deletePosts: vi.fn(),
} satisfies Partial<ApiClient>;

vi.mock("@/lib/api-client", () => ({
  useApiClient: () => apiClient as unknown as ApiClient,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Only the toast host is stubbed out — the table, checkboxes, and alert dialog
// under test are the real primitives from `@unimatrix/ui/editor`.
vi.mock("@unimatrix/ui/editor", async () => {
  const actual = await vi.importActual<typeof EditorModule>("@unimatrix/ui/editor");

  return { ...actual, toast: { success: toastSuccess, error: toastError } };
});

function summary(overrides: Partial<ContentPostSummary> = {}): ContentPostSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    type: "blog",
    slug: "a-post",
    title: "A post",
    summary: "Summary.",
    description: null,
    publicationState: "draft",
    publishedAt: null,
    featured: false,
    projectStatus: null,
    repoUrl: null,
    liveUrl: null,
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  };
}

const DRAFT = summary();
const PUBLISHED = summary({
  id: "22222222-2222-4222-8222-222222222222",
  slug: "shipped",
  title: "Shipped project",
  type: "project",
  publicationState: "published",
  publishedAt: "2026-07-01T00:00:00.000Z",
});

/** The panel for one collection — each owns its own selection and controls. */
function panel(name: "Blog posts" | "Projects") {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
  return within(screen.getByRole("region", { name }));
}

describe("PostsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.adminListPosts.mockResolvedValue({ posts: [DRAFT, PUBLISHED] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists every post in every publication state", async () => {
    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    expect(await screen.findByText("A post")).toBeInTheDocument();
    panel("Projects");
    expect(screen.getByText("Shipped project")).toBeInTheDocument();
    // Drafts are the whole reason this page exists — they are absent from the
    // public list by design.
    panel("Blog posts");
    expect(screen.getByText("draft")).toBeInTheDocument();
    panel("Projects");
    expect(screen.getByText("published")).toBeInTheDocument();
    // One unfiltered request, not one per collection.
    expect(apiClient.adminListPosts).toHaveBeenCalledWith({});
  });

  it("keeps bulk actions hidden until something is selected", async () => {
    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    // Each collection starts with no bulk selection.
    await screen.findByText("A post");
    expect(screen.queryByRole("toolbar", { name: "Selection actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish selected" })).not.toBeInTheDocument();
  });

  it("publishes exactly the selected rows", async () => {
    apiClient.setPostsState.mockResolvedValue({ affected: 1 });

    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select A post" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish selected" }));

    await waitFor(() => {
      expect(apiClient.setPostsState).toHaveBeenCalledWith({
        ids: [DRAFT.id],
        publicationState: "published",
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith("1 post published.");
  });

  it("keeps each collection's select-all to its own rows", async () => {
    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    await screen.findByText("A post");
    fireEvent.click(panel("Blog posts").getByRole("checkbox", { name: "Select all rows" }));

    // The project row is in the sibling table and must be untouched: a shared
    // selection would make a bulk action reach into a collection the admin was
    // not looking at.
    expect(panel("Blog posts").getByText("1 selected")).toBeInTheDocument();
    expect(
      panel("Projects").queryByRole("toolbar", { name: "Selection actions" }),
    ).not.toBeInTheDocument();

    fireEvent.click(panel("Blog posts").getByRole("checkbox", { name: "Select all rows" }));
    expect(
      panel("Blog posts").queryByRole("toolbar", { name: "Selection actions" }),
    ).not.toBeInTheDocument();
  });

  it("names the count in the delete confirmation and deletes nothing until it is confirmed", async () => {
    apiClient.deletePosts.mockResolvedValue({ affected: 2 });

    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    await screen.findByText("A post");
    fireEvent.click(panel("Blog posts").getByRole("checkbox", { name: "Select A post" }));
    fireEvent.click(panel("Projects").getByRole("checkbox", { name: "Select Shipped project" }));
    fireEvent.click(panel("Blog posts").getByRole("button", { name: "Delete selected" }));

    const dialog = await screen.findByRole("alertdialog");

    // The count is the single fact that decides whether this is the intended
    // action, and the database is the only copy of the content now. Scoped to
    // one collection: the sibling's selection must not be counted here.
    expect(within(dialog).getByText("Delete 1 post?")).toBeInTheDocument();
    expect(apiClient.deletePosts).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(apiClient.deletePosts).not.toHaveBeenCalled();

    fireEvent.click(panel("Blog posts").getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() => {
      expect(apiClient.deletePosts).toHaveBeenCalledWith({ ids: [DRAFT.id] });
    });
  });

  it("uses the singular in the confirmation for one post and names it", async () => {
    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select A post" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    const dialog = await screen.findByRole("alertdialog");

    expect(within(dialog).getByText("Delete 1 post?")).toBeInTheDocument();
    expect(within(dialog).getByText(/"A post" will be removed/u)).toBeInTheDocument();
  });

  /**
   * The per-row control targets its own row. Reading the selection instead
   * would make the button delete something the admin never pointed at.
   */
  it("deletes only the row its own delete button belongs to", async () => {
    apiClient.deletePosts.mockResolvedValue({ affected: 1 });

    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    // A different row is ticked, so a selection-driven delete would take it.
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select A post" }));
    fireEvent.click(panel("Projects").getByRole("button", { name: "Delete Shipped project" }));

    const dialog = await screen.findByRole("alertdialog");

    expect(within(dialog).getByText("Delete 1 post?")).toBeInTheDocument();
    expect(within(dialog).getByText(/"Shipped project" will be removed/u)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(apiClient.deletePosts).toHaveBeenCalledWith({ ids: [PUBLISHED.id] });
    });

    // The unrelated selection survives: deleting one row is not a reason to
    // discard a bulk selection the admin is still building.
    panel("Blog posts");
    expect(screen.getByRole("checkbox", { name: "Select A post" })).toBeChecked();
  });

  it("reports a failed load in both panels instead of rendering an empty table", async () => {
    apiClient.adminListPosts.mockRejectedValue(new Error("network down"));

    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    // One request backs both collections, but the failure is reported inside
    // each panel: collapsing to a single combined card would change the shape
    // of the dashboard whenever the API blips.
    expect(await screen.findAllByText("Posts could not be loaded.")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Blog posts" })).toBeInTheDocument();
    panel("Projects");
    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says so when there is nothing to manage", async () => {
    apiClient.adminListPosts.mockResolvedValue({ posts: [] });

    const { PostsPage } = await import("@/features/content/posts-page");

    renderInRouter(<PostsPage />);

    expect(await screen.findAllByText("Nothing here yet.")).toHaveLength(2);
  });
});
