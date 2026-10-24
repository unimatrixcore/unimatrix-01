import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ToolSection } from "../src/tool.js";
import { ToolFooterLink, ToolPageContainer, ToolShell, ToolTitleBar } from "../src/tool.js";

function StubIcon({ className }: { className?: string | undefined }) {
  return <svg className={className} data-testid="section-icon" />;
}

const SECTIONS: ToolSection[] = [
  { active: true, icon: StubIcon, label: "Content", to: "/content" },
];

/**
 * Mounts `ui` under a real router with every path a rendered `Link` (the
 * title bar's `to` form, or a section rail's wordmark and section links)
 * might target registered as a child route.
 */
async function renderInRouter(ui: ReactNode) {
  const rootRoute = createRootRoute();
  const childRoutes = ["/", "/content"].map((path) =>
    createRoute({ component: () => ui, getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren(childRoutes),
  });

  render(<RouterProvider router={router as never} />);

  await act(async () => {
    await router.load();
  });
}

describe("ToolShell", () => {
  it("renders no title bar when the service supplies neither an account control nor a wordmark", async () => {
    await renderInRouter(<ToolShell>tool content</ToolShell>);

    // The `apps/cflop` case. A bar with nothing in it would only cost
    // vertical space, so the shell must not reserve one.
    expect(screen.getByRole("main")).toHaveTextContent("tool content");
    expect(screen.queryByRole("link", { name: "Unimatrix-01" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toBeInTheDocument();
  });

  it("renders the account control and the way back to the public site when given them", async () => {
    await renderInRouter(
      <ToolShell
        accountControl={<button type="button">Account</button>}
        homeHref="https://unimatrix-01.dev/"
        homeLabel="Unimatrix-01"
      >
        tool content
      </ToolShell>,
    );

    const homeLink = screen.getByRole("link", { name: "Unimatrix-01" });

    expect(homeLink).toHaveAttribute("href", "https://unimatrix-01.dev/");
    expect(screen.getByRole("button", { name: "Account" })).toBeInTheDocument();
  });

  it("puts the owner and the tool's own attribution in the footer", async () => {
    await renderInRouter(
      <ToolShell
        footerEnd={<ToolFooterLink href="https://example.test/src">Source</ToolFooterLink>}
        homeHref="https://unimatrix-01.dev/"
        ownerName="Gwen Phalan"
      >
        tool content
      </ToolShell>,
    );

    const footer = screen.getByRole("contentinfo");
    const year = new Date().getFullYear();

    expect(within(footer).getByRole("link", { name: `${year} Gwen Phalan` })).toHaveAttribute(
      "href",
      "https://unimatrix-01.dev/",
    );
    expect(within(footer).getByRole("link", { name: "Source" })).toHaveAttribute(
      "href",
      "https://example.test/src",
    );
  });

  it("falls back to plain copyright text when no public site is given", async () => {
    await renderInRouter(<ToolShell ownerName="Gwen Phalan">tool content</ToolShell>);

    const footer = screen.getByRole("contentinfo");

    expect(footer).toHaveTextContent(`${new Date().getFullYear()} Gwen Phalan`);
    expect(within(footer).queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits the whole footer in the no-sections layout when showFooter is false", async () => {
    await renderInRouter(
      <ToolShell
        footerEnd={<ToolFooterLink href="https://example.test/src">Source</ToolFooterLink>}
        ownerName="Gwen Phalan"
        showFooter={false}
      >
        tool content
      </ToolShell>,
    );

    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source" })).not.toBeInTheDocument();
  });

  it("omits the whole footer in the sections/rail layout when showFooter is false", async () => {
    await renderInRouter(
      <ToolShell
        footerEnd={<ToolFooterLink href="https://example.test/src">Source</ToolFooterLink>}
        ownerName="Gwen Phalan"
        sections={SECTIONS}
        showFooter={false}
      >
        tool content
      </ToolShell>,
    );

    expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Source" })).not.toBeInTheDocument();
  });
});

describe("ToolTitleBar", () => {
  it("renders the routed back control with an accessible name and the view's h1", async () => {
    await renderInRouter(
      <ToolTitleBar
        actions={<span>actions slot</span>}
        back={{ label: "Back to modes", to: "/" }}
        title="Learn OLL"
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Learn OLL" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to modes" })).toHaveAttribute("href", "/");
    expect(screen.getByText("actions slot")).toBeInTheDocument();
  });

  it("renders the callback back control as a button", async () => {
    const onClick = vi.fn();

    await renderInRouter(<ToolTitleBar back={{ label: "Back to cases", onClick }} title="Drill" />);

    fireEvent.click(screen.getByRole("button", { name: "Back to cases" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ToolPageContainer width", () => {
  it.each([
    [{}, "max-w-5xl"],
    [{ wide: true }, "max-w-7xl"],
    [{ width: "default" as const, wide: true }, "max-w-5xl"],
    [{ width: "wide" as const }, "max-w-7xl"],
    [{ width: "full" as const, wide: true }, "max-w-none"],
  ])("resolves %o to %s without leaking layout props onto the DOM", (props, expected) => {
    render(<ToolPageContainer data-testid="container" {...props} />);
    const container = screen.getByTestId("container");
    expect(container).toHaveClass(expected);
    expect(container).not.toHaveAttribute("width");
    expect(container).not.toHaveAttribute("wide");
  });

  it("lets consumer classes override the resolved width", () => {
    render(<ToolPageContainer className="max-w-3xl" data-testid="container" width="full" />);
    expect(screen.getByTestId("container")).toHaveClass("max-w-3xl");
    expect(screen.getByTestId("container")).not.toHaveClass("max-w-none");
  });

  it.each([false, true])(
    "preserves branch defaults and forwards explicit width with rail=%s",
    async (rail) => {
      await renderInRouter(<ToolShell sections={rail ? SECTIONS : []}>tool content</ToolShell>);
      expect(screen.getByRole("main").parentElement).toHaveClass(rail ? "max-w-7xl" : "max-w-5xl");
    },
  );

  it.each([false, true])("forwards full width with rail=%s", async (rail) => {
    await renderInRouter(
      <ToolShell sections={rail ? SECTIONS : []} width="full">
        tool content
      </ToolShell>,
    );
    expect(screen.getByRole("main").parentElement).toHaveClass("max-w-none");
  });
});

describe("ToolShell section height", () => {
  it.each([
    { sections: SECTIONS, footer: true },
    { sections: SECTIONS, footer: false },
    { sections: [], footer: true },
    { sections: [], footer: false },
    { footer: true },
    { footer: false },
  ])(
    "bounds main without moving its title, rail or footer for %o",
    async ({ footer, ...props }) => {
      await renderInRouter(
        <ToolShell {...props} homeLabel="Tool" homeHref="/" scroll="section" showFooter={footer}>
          section content
        </ToolShell>,
      );
      const main = screen.getByRole("main");
      const container = main.parentElement!;
      expect(main).toHaveClass("flex-1", "min-h-0", "min-w-0", "overflow-hidden");
      expect(main).not.toHaveClass("justify-center");
      expect(container).toHaveClass("min-h-0", "min-w-0", "overflow-hidden");
      if ("sections" in props && props.sections.length) {
        expect(container).toHaveClass("h-full");
        expect(container.parentElement).toHaveClass("h-dvh", "min-h-0", "overflow-hidden");
      } else {
        expect(container).toHaveClass("h-dvh");
        expect(screen.getByRole("link", { name: "Tool" }).parentElement).toHaveClass("shrink-0");
      }
      expect(screen.queryAllByRole("contentinfo")).toHaveLength(footer ? 1 : 0);
      if (footer) expect(screen.getByRole("contentinfo")).toHaveClass("shrink-0");
      expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
        "href",
        "#main-content",
      );
    },
  );

  it("retains centered, unbounded page mode by default", async () => {
    await renderInRouter(<ToolShell>page content</ToolShell>);
    const main = screen.getByRole("main");
    expect(main).toHaveClass("justify-center");
    expect(main).not.toHaveClass("overflow-hidden");
    expect(main.parentElement).toHaveClass("min-h-[100dvh]");
    expect(main.parentElement).not.toHaveClass("h-dvh");
  });

  it.each([false, true])(
    "keeps account and page state mounted across mode and rail changes with rail=%s",
    async (rail) => {
      const mounted = vi.fn();
      function Account() {
        useEffect(() => {
          mounted();
        }, []);
        return <button type="button">Account</button>;
      }
      function Example() {
        const [section, setSection] = useState(false);
        return (
          <ToolShell
            accountControl={<Account />}
            sections={rail ? SECTIONS : []}
            scroll={section ? "section" : "page"}
          >
            <input aria-label="Draft" defaultValue="draft" />
            <button
              onClick={() => {
                setSection((value) => !value);
              }}
              type="button"
            >
              Change layout
            </button>
          </ToolShell>
        );
      }
      await renderInRouter(<Example />);
      const main = screen.getByRole("main");
      const account = screen.getByRole("button", { name: "Account" });
      const draft = screen.getByRole("textbox", { name: "Draft" });
      fireEvent.change(draft, { target: { value: "unsaved changes" } });
      fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
      expect(screen.getByRole("main")).toBe(main);
      expect(screen.getByRole("button", { name: "Account" })).toBe(account);
      expect(draft).toHaveValue("unsaved changes");
      if (rail) {
        fireEvent.click(screen.getByRole("button", { name: "Expand sections" }));
        expect(main.parentElement).toHaveAttribute("inert");
        fireEvent.click(screen.getByRole("button", { name: "Collapse sections" }));
        expect(main.parentElement).not.toHaveAttribute("inert");
        expect(screen.getByRole("button", { name: "Account" })).toBe(account);
      }
      fireEvent.click(screen.getByRole("button", { name: "Change layout" }));
      expect(screen.getByRole("main")).toBe(main);
      expect(draft).toHaveValue("unsaved changes");
      expect(mounted).toHaveBeenCalledTimes(1);
    },
  );
});
