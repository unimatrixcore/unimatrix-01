import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importLazyPublicMarkdown() {
  return import("@/features/content/lazy-public-markdown");
}

describe("LazyPublicMarkdown", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@unimatrix/ui/public");
  });

  it("renders markdown content when the public markdown chunk loads", async () => {
    const { LazyPublicMarkdown } = await importLazyPublicMarkdown();

    render(<LazyPublicMarkdown markdown="## Public markdown is live" />);

    expect(
      await screen.findByRole("heading", {
        name: "Public markdown is live",
      }),
    ).toBeInTheDocument();
  });

  it("renders a graceful message when the public markdown chunk fails to load", async () => {
    vi.doMock("@unimatrix/ui/public", async () => {
      throw new Error("chunk unavailable");
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { LazyPublicMarkdown } = await importLazyPublicMarkdown();

    render(<LazyPublicMarkdown markdown="## Public markdown is live" />);

    expect(
      await screen.findByText(
        "Markdown content could not be loaded right now. Refresh the page or try again in a moment.",
      ),
    ).toBeInTheDocument();

    consoleErrorSpy.mockRestore();
  });
});
