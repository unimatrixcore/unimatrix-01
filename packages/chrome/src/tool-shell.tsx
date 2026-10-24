import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { RiArrowLeftLine } from "@remixicon/react";

import { Button, GraphBackground, cn } from "@unimatrix/ui/public";

import { ToolSectionRail, type ToolSection } from "./tool-section-rail.js";

/**
 * The desktop-app shell every tool, dashboard, and admin surface in this repo
 * gets. It is deliberately *not* the public site's chrome: no nav tabs, no site
 * footer, no breadcrumb trail. A tool owns its own navigation, so all this
 * provides is the frame — page container, background field, skip link, an
 * optional title bar carrying the account control and the way back to the
 * public site, and a thin attribution footer.
 *
 * Auth is a slot, not a dependency. `accountControl` takes whatever the service
 * wants there (a Clerk `UserButton`, a sign-in link, nothing at all), which is
 * what keeps this package free of `@unimatrix/auth`: `apps/cflop` is a
 * public, sign-in-free tool and must not gain an auth dependency by importing
 * its shell. The public shell in `./public` takes the same slot for the same
 * reason.
 */

export type ToolPageWidth = "default" | "wide" | "full";

export type ToolPageContainerProps = React.ComponentProps<"div"> & {
  /** Explicit width takes precedence over the legacy `wide` flag. */
  width?: ToolPageWidth;
  wide?: boolean;
};

export type ToolShellProps = {
  /**
   * Rendered at the right of the title bar. When this and `homeHref` are both
   * absent no title bar is rendered at all, and the shell is container +
   * field + main + footer.
   *
   * Takes the render-prop form when the app needs to adapt to the section
   * rail's collapsed state — a `ReactNode` alone cannot see it, since the
   * package cannot restyle a slot it does not control, and this is what lets
   * the app itself change how it renders that slot without the package
   * gaining any knowledge of what is inside it (or `@unimatrix/auth`, which
   * it must never depend on). Resolved with `{ collapsed: false }` when
   * `sections` is absent, since there is no rail and so no collapse concept.
   */
  accountControl?: React.ReactNode | ((state: { collapsed: boolean }) => React.ReactNode);
  children: React.ReactNode;
  className?: string;
  width?: ToolPageWidth;
  /**
   * Right-hand cluster of the footer — source links, data attribution, and
   * anything else that is specific to this tool. Use `ToolFooterLink` for the
   * links so the styling stays here rather than being copied per service.
   */
  footerEnd?: React.ReactNode;
  /**
   * Absolute URL of the public site. Rendered as the wordmark's link in the
   * title bar and as the copyright link in the footer — the "way back to the
   * public site" a tool shell owes its user.
   */
  homeHref?: string;
  /** Wordmark shown in the title bar beside `homeHref`. */
  homeLabel?: string;
  /**
   * `src` for the wordmark's logo image when `sections` is given. Defaults to
   * `/logo.png`, matching the public shell's own default.
   */
  logoSrc?: string;
  /** Name in the footer's copyright line. */
  ownerName?: string;
  /**
   * The tool's section rail. When given a non-empty list, the shell renders a
   * collapsible vertical rail in place of the title bar —
   * the wordmark and `accountControl` both move into it. An empty
   * array is treated the same as omitting `sections` entirely, so a caller
   * computing sections from permissions falls back to today's layout instead
   * of losing its wordmark and account control to an empty rail.
   */
  sections?: readonly ToolSection[];
  /** Where the rail's wordmark links. Defaults to `"/"`. */
  sectionsHomeHref?: string;
  /** The rail `<nav>`'s `aria-label`. Defaults to `"Sections"`. */
  sectionsLabel?: string;
  /**
   * Renders the footer element. Defaults to `true`; set to `false` to omit
   * the whole `<footer>`, including the `contentinfo` landmark.
   */
  showFooter?: boolean;
  /** Section mode bounds the frame; children own their scrolling within `main`. */
  scroll?: "page" | "section";
};

const DEFAULT_OWNER_NAME = "Gwen Phalan";

function resolveAccountControl(
  accountControl: ToolShellProps["accountControl"],
  collapsed: boolean,
): React.ReactNode {
  return typeof accountControl === "function" ? accountControl({ collapsed }) : accountControl;
}

export function ToolPageContainer({ className, wide, width, ...props }: ToolPageContainerProps) {
  const widthClasses: Record<ToolPageWidth, string> = {
    default: "max-w-5xl",
    wide: "max-w-7xl",
    full: "max-w-none",
  };
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-[100dvh] w-full flex-col gap-8 px-4 py-4 sm:px-6 lg:gap-10 lg:px-8 lg:py-6",
        widthClasses[width ?? (wide ? "wide" : "default")],
        className,
      )}
      {...props}
    />
  );
}

/**
 * The row that opens a view: a back control, the view's `h1`, and whatever that
 * view puts opposite them.
 *
 * `back` is a discriminated pair rather than a `ReactNode`: every call site
 * either routes somewhere or steps a local mode back, and taking the button as
 * a slot would let a caller ship one without an accessible name.
 */
export function ToolTitleBar({
  actions,
  back,
  title,
}: {
  actions?: React.ReactNode;
  back: { label: string } & ({ onClick: () => void } | { to: string });
  title: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        {"to" in back ? (
          <Button asChild aria-label={back.label} size="icon" variant="outline">
            <Link to={back.to}>
              <RiArrowLeftLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        ) : (
          <Button aria-label={back.label} onClick={back.onClick} size="icon" variant="outline">
            <RiArrowLeftLine aria-hidden="true" className="size-4" />
          </Button>
        )}
        <h1 className="text-xl font-medium tracking-[-0.03em] text-foreground">{title}</h1>
      </div>

      {actions === undefined ? null : <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

/**
 * External link in the tool footer. Exists so a service adds its own
 * attribution without re-deriving the underline and hover treatment.
 */
export function ToolFooterLink({ className, ...props }: React.ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "underline decoration-muted-foreground/35 underline-offset-4 transition-colors hover:text-foreground",
        className,
      )}
      rel="noreferrer"
      target="_blank"
      {...props}
    />
  );
}

function ToolFooter({
  bounded,
  end,
  homeHref,
  ownerName,
}: {
  bounded: boolean;
  end: React.ReactNode | undefined;
  homeHref: string | undefined;
  ownerName: string;
}) {
  const year = new Date().getFullYear();
  const copyright = `${year} ${ownerName}`;

  return (
    <footer className={cn("py-1", bounded && "shrink-0")}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground/85">
        <p>
          ©{" "}
          {homeHref === undefined ? (
            copyright
          ) : (
            <ToolFooterLink href={homeHref}>{copyright}</ToolFooterLink>
          )}
        </p>
        {end === undefined ? null : <p>{end}</p>}
      </div>
    </footer>
  );
}

export function ToolShell({
  accountControl,
  children,
  className,
  footerEnd,
  homeHref,
  homeLabel,
  logoSrc = "/logo.png",
  ownerName = DEFAULT_OWNER_NAME,
  sections,
  sectionsHomeHref = "/",
  sectionsLabel = "Sections",
  showFooter = true,
  scroll = "page",
  width,
}: ToolShellProps) {
  // An empty array falls back to the no-sections layout, not a rail with
  // nothing in it — a caller computing `sections` from permissions must not
  // lose its wordmark and account control to a rail with no sections in it.
  const hasSections = sections !== undefined && sections.length > 0;
  // A tool with neither an account control nor a wordmark has nothing to put in
  // a title bar, and an empty bar would only cost vertical space. `apps/cflop`
  // is that case today, which is why migrating it onto this shell is a no-op on
  // screen rather than a redesign. A rail replaces the title bar outright, so
  // it is forced off when `hasSections` even if both are supplied.
  const hasTitleBar = !hasSections && (accountControl !== undefined || homeLabel !== undefined);
  const [collapsed, setCollapsed] = useState(true);
  const railId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusToggleOnTransition = useRef(false);
  const railOpen = hasSections && !collapsed;
  const sectionScroll = scroll === "section";

  useEffect(() => {
    if (focusToggleOnTransition.current) {
      focusToggleOnTransition.current = false;
      toggleRef.current?.focus();
    }
  }, [collapsed]);

  function dismissRail() {
    focusToggleOnTransition.current = true;
    setCollapsed(true);
  }
  // The no-sections layout has no rail and so no collapse concept: the
  // function form of `accountControl` always resolves with `collapsed:
  // false` there, never the state variable above (which this branch never
  // sets anyway).
  const resolvedAccountControl = resolveAccountControl(accountControl, hasSections && collapsed);

  const main = (
    <main
      className={cn(
        "flex flex-1 flex-col gap-8 lg:gap-10",
        sectionScroll ? "min-h-0 min-w-0 overflow-hidden" : !hasSections && "justify-center",
      )}
      id="main-content"
    >
      {children}
    </main>
  );

  const skipLink = (
    <a
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border focus:border-primary/45 focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
      aria-disabled={railOpen || undefined}
      href={railOpen ? undefined : "#main-content"}
      tabIndex={railOpen ? -1 : undefined}
    >
      Skip to main content
    </a>
  );

  // The rail is application chrome and belongs against the viewport edge, so it
  // sits *outside* `ToolPageContainer` rather than inside it. Only the content
  // region keeps the centred, padded column — putting the whole layout in one
  // container insets the rail by the container's own gutter and makes it read
  // as a card on a page.
  // `pl-16` is the gutter the fixed rail sits in, and it is deliberately the
  // *collapsed* width rather than the expanded one. The rail is out of flow, so
  // this is the only thing reserving space for it; pinning the gutter to one
  // width is what stops expanding the rail from shoving the page sideways.
  // Expansion is transient: the scrim blocks the page until the rail closes.
  if (hasSections) {
    return (
      <div
        className={cn(
          "relative flex min-h-[100dvh] w-full pl-16",
          sectionScroll && "h-dvh min-h-0 overflow-hidden",
          className,
        )}
      >
        <GraphBackground />
        {skipLink}

        {railOpen ? (
          <button
            aria-label="Close sections"
            className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]"
            onClick={dismissRail}
            tabIndex={-1}
            type="button"
          />
        ) : null}

        <ToolSectionRail
          accountControl={resolvedAccountControl}
          collapsed={collapsed}
          homeLabel={homeLabel}
          logoSrc={logoSrc}
          onDismiss={dismissRail}
          onNavigate={() => {
            focusToggleOnTransition.current = false;
            setCollapsed(true);
          }}
          onToggleCollapsed={() => {
            focusToggleOnTransition.current = true;
            setCollapsed((wasCollapsed) => !wasCollapsed);
          }}
          railId={railId}
          sections={sections}
          sectionsHomeHref={sectionsHomeHref}
          sectionsLabel={sectionsLabel}
          toggleRef={toggleRef}
        />

        <ToolPageContainer
          className={cn("min-h-0 flex-1", sectionScroll && "h-full min-w-0 overflow-hidden")}
          inert={railOpen}
          width={width ?? "wide"}
        >
          {main}
          {showFooter ? (
            <ToolFooter
              bounded={sectionScroll}
              end={footerEnd}
              homeHref={homeHref}
              ownerName={ownerName}
            />
          ) : null}
        </ToolPageContainer>
      </div>
    );
  }

  return (
    <ToolPageContainer
      className={cn(sectionScroll && "h-dvh min-h-0 min-w-0 overflow-hidden", className)}
      width={width ?? "default"}
    >
      <GraphBackground />

      {skipLink}

      {hasTitleBar ? (
        <div className={cn("flex items-center justify-between gap-4", sectionScroll && "shrink-0")}>
          {homeLabel === undefined ? (
            <span />
          ) : (
            <a
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              href={homeHref}
            >
              {homeLabel}
            </a>
          )}
          {accountControl === undefined ? null : (
            <div className="flex shrink-0 items-center gap-2">{resolvedAccountControl}</div>
          )}
        </div>
      ) : null}

      {main}

      {showFooter ? (
        <ToolFooter
          bounded={sectionScroll}
          end={footerEnd}
          homeHref={homeHref}
          ownerName={ownerName}
        />
      ) : null}
    </ToolPageContainer>
  );
}
