import type { ComponentType, MouseEvent, ReactNode, Ref } from "react";
import { Link, useRouter, type RouterHistory } from "@tanstack/react-router";
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
  const router = useRouter();

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
      const location = router.state.resolvedLocation ?? router.state.location;
      const history = router.history as RouterHistory;
      const currentHref =
        history.createHref(location.maskedLocation?.publicHref ?? location.publicHref) || "/";
      if (!collapsed && event.currentTarget.getAttribute("href") === currentHref) {
        // Same-URL navigation has no destination focus to replace the removed wordmark.
        document
          .getElementById(railId)
          ?.querySelector<HTMLButtonElement>("button[aria-controls]")
          ?.focus();
      }
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
        // The rail owns its stacking order; the brand and toggle stay in its
        // header flow so neither can intercept a control beside the rail.
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
      <div className={cn("flex h-9 min-w-0 items-center gap-2", collapsed && "justify-center")}>
        {collapsed ? null : (
          <Link
            aria-label={homeLabel}
            // The 24px logo and labels align with the nav's 16px icons and labels.
            className="flex h-9 min-w-0 flex-1 items-center gap-1.5 pl-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={handleNavigation}
            to={sectionsHomeHref}
          >
            <img alt="" className="size-6 shrink-0" src={logoSrc} />
            <span className="truncate">{homeLabel}</span>
          </Link>
        )}

        <Button
          aria-controls={railId}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sections" : "Collapse sections"}
          className="group relative shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
          onClick={onToggleCollapsed}
          ref={toggleRef}
          size="icon"
          variant="ghost"
        >
          {collapsed ? (
            <>
              <img
                alt=""
                className="size-6 group-hover:opacity-0 group-focus-visible:opacity-0"
                src={logoSrc}
              />
              <RiSidebarUnfoldLine
                aria-hidden="true"
                className="absolute size-5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </>
          ) : (
            <RiSidebarFoldLine aria-hidden="true" className="size-5" />
          )}
        </Button>
      </div>

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

          `border-y` frames the control with a rule on both sides. `mb-2`
          keeps it clear of the viewport edge without changing the rail padding. */}
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
