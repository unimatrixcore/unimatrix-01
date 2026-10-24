import type { ComponentType, MouseEvent, ReactNode, Ref } from "react";
import { Link } from "@tanstack/react-router";
import { RiSidebarFoldLine, RiSidebarUnfoldLine } from "@remixicon/react";

import { Button, cn } from "@unimatrix/ui/public";

/**
 * Narrower than the icon libraries' own prop types, same as `PublicNavIcon`
 * in `./public-shell.tsx` and for the same two reasons: it is the only
 * surface this file uses, and under `exactOptionalPropertyTypes` a class
 * component's `defaultProps` — which is how Remix icons are typed — is
 * checked against this shape, so a target without `| undefined` on every
 * prop rejects them.
 */
export type ToolSectionIcon = ComponentType<{
  "aria-hidden"?: boolean | "true" | "false" | undefined;
  className?: string | undefined;
}>;

/**
 * One entry in a tool's section rail. `to` plus a plain `active` boolean,
 * never `href` or `activeOptions`: an `href` renders a plain `<a>` and
 * full-reloads out of the SPA, and computing the active match here would put
 * route knowledge in the package rather than the app that owns it.
 */
export type ToolSection = {
  active: boolean;
  icon?: ToolSectionIcon;
  label: string;
  to: string;
};

/**
 * The collapsible vertical rail `ToolShell` renders in place of its title bar
 * and footer strip when it is given `sections`. Holds no state of its own —
 * `collapsed` and `onToggleCollapsed` come from `ToolShell`, which is its only
 * caller. `ToolShell` also owns the footer strip itself: this rail renders
 * only the wordmark, the toggle, the section nav, and the account control.
 */
export function ToolSectionRail({
  accountControl,
  collapsed,
  homeLabel,
  logoSrc,
  onDismiss,
  onNavigate,
  onToggleCollapsed,
  railId,
  sections,
  sectionsHomeHref,
  sectionsLabel,
  toggleRef,
}: {
  accountControl?: ReactNode;
  collapsed: boolean;
  homeLabel: string | undefined;
  logoSrc: string;
  onDismiss: () => void;
  onNavigate: () => void;
  onToggleCollapsed: () => void;
  railId: string;
  sections: readonly ToolSection[];
  sectionsHomeHref: string;
  sectionsLabel: string;
  toggleRef: Ref<HTMLButtonElement>;
}) {
  function handleNavigation(event: MouseEvent<HTMLAnchorElement>) {
    const target = event.currentTarget.getAttribute("target");
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      (!target || target === "_self")
    ) {
      onNavigate();
    }
  }

  return (
    <div
      className={cn(
        // Flush to the viewport edge and full height: this is application
        // chrome, not a card on a page. Only the content region beside it gets
        // the shell's centred, padded container.
        //
        // `fixed`, so expanding the rail never reflows the page. The shell
        // reserves a constant gutter the width of the *collapsed* rail, and an
        // expanded rail spans that gutter onto the content rather than pushing
        // it — content that jumped sideways every time the rail opened would
        // cost the reader their place for no information.
        //
        // Being positioned also makes this the toggle's containing block, so
        // it must never gain `overflow-hidden` or the part of the toggle that
        // overhangs the right edge is clipped away.
        //
        // `z-50` belongs on the rail, not only on the toggle inside it.
        // `backdrop-blur-sm` sets a `backdrop-filter`, which creates a
        // stacking context, so a `z-index` on a descendant is confined to the
        // rail and never competes with the page. Without it the toggle — which
        // hangs past the rail's edge — is painted over by `ToolPageContainer`
        // and stops being clickable while still looking perfectly fine.
        "fixed top-0 left-0 z-50 flex h-[100dvh] shrink-0 flex-col gap-4 border-r border-border/60 bg-background/95 p-3 backdrop-blur-sm",
        collapsed ? "w-16" : "w-72",
      )}
      id={railId}
      onKeyDown={(event) => {
        // Account popups can bubble through this React tree from a portal.
        if (
          !collapsed &&
          event.key === "Escape" &&
          !event.defaultPrevented &&
          event.currentTarget.contains(event.target as Node)
        ) {
          const popupTrigger = (event.target as Element).closest(
            '[aria-expanded="true"][aria-haspopup]:not([aria-haspopup="false"])',
          );
          // Popups retaining trigger focus may handle Escape at the document.
          if (popupTrigger && event.currentTarget.contains(popupTrigger)) return;
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      {/* Floats outside the rail's own flow so it can sit beside it rather
          than sharing a row (and the wordmark's width) with the wordmark.
          `left-full` places the button's left edge at the rail's own right
          edge — entirely outside the border, not straddling it — and `ml-2`
          (8px) opens a small gap past that edge. `top-3` matches the rail's
          `p-3` padding, and both this button and the wordmark link below are
          `h-9`, so their centres land on the same line. Because the position
          is relative to the rail's own edge rather than a fixed offset, it
          does not move when the rail's width changes between collapsed and
          expanded, and it does not depend on the button's own width either. */}
      <Button
        aria-controls={railId}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand sections" : "Collapse sections"}
        className="absolute top-3 left-full z-10 ml-2 text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={onToggleCollapsed}
        ref={toggleRef}
        size="icon"
        variant="ghost"
      >
        {collapsed ? (
          <RiSidebarUnfoldLine aria-hidden="true" className="size-5" />
        ) : (
          <RiSidebarFoldLine aria-hidden="true" className="size-5" />
        )}
      </Button>

      <Link
        // On the route the wordmark points at, this link and that section's
        // link both report `aria-current="page"`. It cannot be suppressed
        // from here: `Link` spreads its own `aria-current` after every
        // caller-supplied prop, including `activeProps`. Two current links
        // is a smell rather than a violation, and the alternative — a plain
        // `<a>` — trades it for a full document reload on a same-origin
        // route. Same trade the public shell's logo link already makes.
        aria-label={homeLabel}
        // `pl-2` and `gap-1.5` here — instead of the section links' own
        // `px-3` and `gap-2.5` below — are deliberate, not drift to tidy
        // away: they're what puts this 24px logo and the section links'
        // 16px icons on one centre column, and both labels on one left
        // edge, despite the rail's uniform `p-3`. A section icon's centre
        // sits at the rail's `p-3` (12px) + the link's own `px-3` (12px) +
        // half the icon (8px) = 32px from the rail's edge. Centring the
        // logo there needs its left edge at 32 - 12 (half the logo) = 20px,
        // i.e. the rail's 12px plus this `pl-2` (8px). From that edge,
        // `gap-1.5` (6px) lands the wordmark label at 20 + 24 + 6 = 50px —
        // the same spot the section labels land at (24 + 16 + their
        // `gap-2.5` [10px] = 50px). `gap-2.5` on the wider logo would miss
        // that by 4px. Collapsed, this link centres itself instead
        // (`justify-center`), so the padding is dropped rather than fighting it.
        className={cn(
          "flex h-9 min-w-0 items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
          collapsed ? "justify-center" : "pl-2",
        )}
        onClick={handleNavigation}
        to={sectionsHomeHref}
      >
        <img alt="" className="size-6 shrink-0" src={logoSrc} />
        {/* Collapsed, the logo is the whole affordance — the wordmark is not
            hidden, it is not rendered. `aria-label` already carries the name,
            so a screen reader loses nothing, and an `sr-only` copy of the
            same string beside it would be dead markup either way. */}
        {collapsed ? null : <span className="truncate">{homeLabel}</span>}
      </Link>

      <nav aria-label={sectionsLabel} className="flex flex-1 flex-col gap-1">
        {sections.map((section) => {
          const Icon = section.icon;

          return (
            <Link
              aria-current={section.active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-sm px-3 text-sm transition-colors",
                collapsed && "justify-center px-2",
                section.active
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              key={section.to}
              onClick={handleNavigation}
              title={section.label}
              to={section.to}
            >
              {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
              <span className={cn("truncate", collapsed && "sr-only")}>{section.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* The slot is a `ReactNode` the package cannot measure or restyle, and
          collapsed the rail is narrower than plenty of plausible controls —
          Clerk's signed-in `<UserButton />` is an avatar that fits, its
          signed-out button is text that does not. Without this the control
          escapes the rail on both sides and paints over the content region.
          `block` is doing real work: a slot rendering an inline `<a>` ignores
          `max-width` entirely, so clipping it needs a block box first.

          Expanded, `pl-2` is the same 8px the wordmark link above uses, and
          for the same reason: it is what puts a 24px control's centre on the
          32px column the section icons sit on. A slot that renders something
          other than 24px wide will not land there — the shell cannot measure
          the slot, so the app supplying it owns matching that size. Collapsed,
          the rail centres it instead and the padding is dropped.

          `border-y` frames the control with a rule on both sides, matching
          the top one already separating it from the nav. `mb-2` nudges it up
          from the rail's bottom edge; it lives on this div rather than on the
          rail's own `p-3` because other comments in this file key the
          toggle button's `top-3` offset and the wordmark's `pl-2` centering
          off that value, and growing it would misalign both. */}
      {accountControl === undefined ? null : (
        <div
          className={cn(
            "mb-2 flex min-w-0 items-center overflow-hidden border-y border-border/60 py-3",
            collapsed ? "justify-center [&>*]:block [&>*]:max-w-full [&>*]:truncate" : "pl-2",
          )}
        >
          {accountControl}
        </div>
      )}
    </div>
  );
}
