import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { act, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";

import type { ToolSection } from "../src/tool.js";
import { ToolShell } from "../src/tool.js";

function StubIcon({ className }: { className?: string | undefined }) {
  return <svg className={className} data-testid="section-icon" />;
}

const SECTIONS: ToolSection[] = [
  { active: false, icon: StubIcon, label: "Content", to: "/content" },
  { active: true, icon: StubIcon, label: "Feedback", to: "/feedback" },
];

/**
 * Mounts `ui` under a real router with every path the rail's `Link`s (and the
 * wordmark's) might target registered as a child route.
 */
async function renderInRouter(ui: ReactNode, initialEntry = "/") {
  const rootRoute = createRootRoute({ component: () => ui });
  const childRoutes = ["/", "/content", "/feedback"].map((path) =>
    createRoute({ getParentRoute: () => rootRoute, path }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren(childRoutes),
  });

  render(<RouterProvider router={router as never} />);

  await act(async () => {
    await router.load();
  });

  return router;
}

describe("ToolShell without sections", () => {
  it("renders no section rail, a title bar, and one footer landmark", async () => {
    await renderInRouter(
      <ToolShell
        accountControl={<button type="button">Account</button>}
        homeHref="https://unimatrix-01.dev/"
        homeLabel="Unimatrix-01"
      >
        tool content
      </ToolShell>,
    );

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Unimatrix-01" })).toBeInTheDocument();
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });
});

describe("ToolShell with sections", () => {
  it("renders one named navigation landmark, one link per section, and no title bar", async () => {
    await renderInRouter(
      <ToolShell accountControl={<button type="button">Account</button>} sections={SECTIONS}>
        tool content
      </ToolShell>,
    );

    const nav = screen.getByRole("navigation", { name: "Sections" });

    expect(within(nav).getByRole("link", { name: "Content" })).toHaveAttribute("href", "/content");
    expect(within(nav).getByRole("link", { name: "Feedback" })).toHaveAttribute(
      "href",
      "/feedback",
    );
    // The wordmark, not a title bar: `homeLabel` moved into the rail, so no
    // second copy of it renders outside `nav`.
    expect(screen.queryByRole("link", { name: "Unimatrix-01" })).not.toBeInTheDocument();
  });

  it("renders the copyright in the footer below the content", async () => {
    await renderInRouter(
      <ToolShell ownerName="Gwen Phalan" sections={SECTIONS}>
        tool content
      </ToolShell>,
    );

    const footer = screen.getByRole("contentinfo");

    expect(footer).toHaveTextContent(`${new Date().getFullYear()} Gwen Phalan`);
  });

  it("renders exactly one contentinfo landmark", async () => {
    await renderInRouter(
      <ToolShell accountControl={<button type="button">Account</button>} sections={SECTIONS}>
        tool content
      </ToolShell>,
    );

    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });

  it("starts collapsed, exposes its controlled rail, and focuses the same toggle only on transitions", async () => {
    await renderInRouter(<ToolShell sections={SECTIONS}>tool content</ToolShell>);

    const toggle = screen.getByRole("button", { name: "Expand sections" });
    const rail = document.getElementById(toggle.getAttribute("aria-controls")!);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveFocus();
    expect(rail).toHaveClass("w-16");
    expect(screen.queryByRole("button", { name: "Close sections" })).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAccessibleName("Collapse sections");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveFocus();
    expect(rail).toHaveClass("w-72");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rail).not.toHaveAttribute("aria-modal");

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Expand sections" })).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(screen.getByRole("link", { name: "Content" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Feedback" })).toBeInTheDocument();
  });

  it("resolves the accountControl render-prop form with the rail's collapsed state", async () => {
    const accountControl = vi.fn(({ collapsed }: { collapsed: boolean }) => (
      <span>{collapsed ? "collapsed" : "expanded"}</span>
    ));

    await renderInRouter(
      <ToolShell accountControl={accountControl} sections={SECTIONS}>
        tool content
      </ToolShell>,
    );

    expect(accountControl).toHaveBeenCalledWith({ collapsed: true });
    expect(screen.getByText("collapsed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Expand sections" }));

    expect(accountControl).toHaveBeenCalledWith({ collapsed: false });
    expect(screen.getByText("expanded")).toBeInTheDocument();
  });

  it("blocks the entire page and footer, disables its skip link, and restores them after scrim dismissal", async () => {
    await renderInRouter(
      <ToolShell footerEnd={<a href="https://example.test">Source</a>} sections={SECTIONS}>
        <button type="button">Refresh</button>
      </ToolShell>,
    );
    const page = screen.getByRole("main").parentElement!;
    const footer = screen.getByRole("contentinfo");
    const skipLink = screen.getByRole("link", { name: "Skip to main content" });
    const toggle = screen.getByRole("button", { name: "Expand sections" });

    expect(page.parentElement).toHaveClass("pl-16");
    expect(page).not.toHaveAttribute("inert");
    fireEvent.click(toggle);

    expect(page).toHaveAttribute("inert");
    expect(page).toContainElement(footer);
    expect(skipLink).toHaveAttribute("aria-disabled", "true");
    expect(skipLink).toHaveAttribute("tabindex", "-1");
    expect(skipLink).not.toHaveAttribute("href");
    expect(toggle.closest("[inert]")).toBeNull();
    expect(document.body).not.toHaveAttribute("inert");
    expect(page.parentElement).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Close sections" }));

    expect(page).not.toHaveAttribute("inert");
    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(skipLink).not.toHaveAttribute("aria-disabled");
    expect(skipLink).not.toHaveAttribute("tabindex");
    expect(toggle).toHaveFocus();
  });

  it("preserves page state and the single account instance across repeated expansion", async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Account({ collapsed }: { collapsed: boolean }) {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <button
          onClick={() => {
            setCount((value) => value + 1);
          }}
          type="button"
        >
          Account {count} {collapsed ? "compact" : "full"}
        </button>
      );
    }
    function Page() {
      const [count, setCount] = useState(0);
      return (
        <>
          <input aria-label="Draft" defaultValue="unsaved" />
          <button
            onClick={() => {
              setCount((value) => value + 1);
            }}
            type="button"
          >
            Refresh {count}
          </button>
        </>
      );
    }
    await renderInRouter(
      <ToolShell accountControl={(state) => <Account {...state} />} sections={SECTIONS}>
        <Page />
      </ToolShell>,
    );
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const account = screen.getByRole("button", { name: "Account 0 compact" });
    const toggle = screen.getByRole("button", { name: "Expand sections" });
    fireEvent.change(draft, { target: { value: "keep my edits" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh 0" }));
    fireEvent.click(account);

    for (let index = 0; index < 2; index += 1) {
      fireEvent.click(toggle);
      expect(screen.getByRole("button", { name: "Account 1 full" })).toBe(account);
      fireEvent.click(toggle);
    }

    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("keep my edits");
    expect(screen.getByRole("button", { name: "Refresh 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account 1 compact" })).toBe(account);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("ignores handled Escape and account-portal events, then dismisses unhandled rail Escape", async () => {
    function Account() {
      const [count, setCount] = useState(0);
      return (
        <>
          <button
            onKeyDown={(event) => {
              event.preventDefault();
            }}
            type="button"
          >
            Account
          </button>
          {createPortal(
            <button
              onClick={() => {
                setCount((value) => value + 1);
              }}
              type="button"
            >
              Account popup {count}
            </button>,
            document.body,
          )}
        </>
      );
    }
    await renderInRouter(
      <ToolShell accountControl={<Account />} sections={SECTIONS}>
        <button type="button">Page action</button>
      </ToolShell>,
    );
    const toggle = screen.getByRole("button", { name: "Expand sections" });
    fireEvent.click(toggle);
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.keyDown(account, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(account).toHaveFocus();

    const popup = screen.getByRole("button", { name: "Account popup 0" });
    popup.focus();
    fireEvent.click(popup);
    expect(popup).toHaveAccessibleName("Account popup 1");
    expect(popup).toHaveFocus();
    expect(popup.closest("[inert]")).toBeNull();
    expect(fireEvent.keyDown(popup, { key: "Escape" })).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(popup).toHaveFocus();

    expect(
      fireEvent.keyDown(screen.getByRole("button", { name: "Page action" }), { key: "Escape" }),
    ).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("link", { name: "Content" }), { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    expect(fireEvent.keyDown(toggle, { key: "Escape" })).toBe(true);
  });

  it.each([false, true])(
    "lets an open account popup own Escape from its trigger (descendant target: %s)",
    async (descendantTarget) => {
      const popupEscape = vi.fn();
      function Account() {
        const [open, setOpen] = useState(false);
        useEffect(() => {
          if (!open) return;
          function handleEscape(event: KeyboardEvent) {
            if (event.key === "Escape") {
              popupEscape();
              setOpen(false);
            }
          }
          document.addEventListener("keydown", handleEscape);
          return () => {
            document.removeEventListener("keydown", handleEscape);
          };
        }, [open]);
        return (
          <>
            <button
              aria-controls="account-popup"
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={() => {
                setOpen(true);
              }}
              type="button"
            >
              <span>Account</span>
            </button>
            {open &&
              createPortal(
                <div aria-label="Account popup" id="account-popup" role="dialog" />,
                document.body,
              )}
          </>
        );
      }
      await renderInRouter(
        <ToolShell accountControl={<Account />} sections={SECTIONS}>
          tool content
        </ToolShell>,
      );
      const toggle = screen.getByRole("button", { name: "Expand sections" });
      const page = screen.getByRole("main").parentElement!;
      fireEvent.click(toggle);
      const account = screen.getByRole("button", { name: "Account" });
      account.focus();
      fireEvent.click(account);
      expect(screen.getByRole("dialog", { name: "Account popup" })).toBeInTheDocument();

      const target = descendantTarget ? within(account).getByText("Account") : account;
      expect(fireEvent.keyDown(target, { key: "Escape" })).toBe(true);
      expect(popupEscape).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: "Account popup" })).not.toBeInTheDocument();
      expect(account).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(page).toHaveAttribute("inert");
      expect(account).toHaveFocus();

      fireEvent.keyDown(account, { key: "Escape" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(page).not.toHaveAttribute("inert");
      expect(toggle).toHaveFocus();
      expect(popupEscape).toHaveBeenCalledTimes(1);
    },
  );

  it("dismisses for Escape from an expanded control without a popup", async () => {
    await renderInRouter(
      <ToolShell
        accountControl={
          <button aria-expanded="true" aria-haspopup="false" type="button">
            Account
          </button>
        }
        sections={SECTIONS}
      >
        tool content
      </ToolShell>,
    );
    const toggle = screen.getByRole("button", { name: "Expand sections" });
    fireEvent.click(toggle);
    const account = screen.getByRole("button", { name: "Account" });
    account.focus();
    fireEvent.keyDown(account, { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });

  it.each([
    ["Feedback", "/feedback"],
    ["Tool home", "/"],
  ])(
    "dismisses for ordinary %s navigation without stealing destination focus",
    async (label, destination) => {
      function DestinationAction() {
        const pathname = useRouterState({ select: (state) => state.location.pathname });
        const ref = useRef<HTMLButtonElement>(null);
        useEffect(() => {
          if (pathname === destination) ref.current?.focus();
        }, [pathname]);
        return (
          <button ref={ref} type="button">
            Destination action
          </button>
        );
      }
      const router = await renderInRouter(
        <ToolShell homeLabel="Tool home" sections={SECTIONS}>
          <DestinationAction />
        </ToolShell>,
        "/content",
      );
      const toggle = screen.getByRole("button", { name: "Expand sections" });
      fireEvent.click(toggle);
      fireEvent.click(screen.getByRole("link", { name: label }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe(destination);
      });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: "Destination action" })).toHaveFocus();
      expect(screen.getByRole("main").parentElement).not.toHaveAttribute("inert");
    },
  );

  it("keeps modified, non-primary, new-tab and prevented navigation events unchanged", async () => {
    const router = await renderInRouter(
      <ToolShell homeLabel="Tool home" sections={SECTIONS}>
        tool content
      </ToolShell>,
    );
    const toggle = screen.getByRole("button", { name: "Expand sections" });
    fireEvent.click(toggle);
    const link = screen.getByRole("link", { name: "Content" });
    for (const event of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      fireEvent.click(link, event);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
    link.setAttribute("target", "_blank");
    fireEvent.click(link);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    link.removeAttribute("target");
    const preventNavigation = (event: Event) => {
      event.preventDefault();
    };
    link.addEventListener("click", preventNavigation);
    fireEvent.click(link);
    link.removeEventListener("click", preventNavigation);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(router.state.location.pathname).toBe("/");
  });

  it("uses a distinct controlled rail id for each mounted shell", async () => {
    await renderInRouter(
      <>
        <ToolShell sections={SECTIONS}>first tool</ToolShell>
        <ToolShell sections={SECTIONS}>second tool</ToolShell>
      </>,
    );
    const ids = screen
      .getAllByRole("button", { name: "Expand sections" })
      .map((toggle) => toggle.getAttribute("aria-controls"));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(document.getElementById(id!)).toBeInTheDocument();
  });

  it("marks only the active section as the current page", async () => {
    await renderInRouter(<ToolShell sections={SECTIONS}>tool content</ToolShell>);

    expect(screen.getByRole("link", { name: "Content" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Feedback" })).toHaveAttribute("aria-current", "page");
  });

  it("falls back to the no-sections layout when sections is an empty array", async () => {
    await renderInRouter(
      <ToolShell
        accountControl={<button type="button">Account</button>}
        homeHref="https://unimatrix-01.dev/"
        homeLabel="Unimatrix-01"
        sections={[]}
      >
        tool content
      </ToolShell>,
    );

    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Unimatrix-01" })).toBeInTheDocument();
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  });
});
