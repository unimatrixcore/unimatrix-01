import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { RiArrowRightSLine } from "@remixicon/react";

import { GraphBackground, cn } from "@unimatrix/ui/public";

/**
 * The public site's chrome: sticky header, nav tabs, breadcrumb trail, the
 * condensed bar that replaces the header on scroll, and the site footer. This
 * is the content-surface counterpart to `./tool` — per AGENTS.md the split is
 * tool vs content, not signed-in vs public, so a sign-in-free tool like
 * `apps/cflop` takes the tool shell and never this one.
 *
 * Route knowledge is passed in, not computed here. The nav items arrive with
 * `active` already resolved and the breadcrumb trail arrives fully built,
 * because which routes exist and what a crumb is called is the consuming app's
 * business. What this package owns is the frame those things are rendered in.
 *
 * Auth is a slot for the same reason it is in the tool shell: `accountControl`
 * takes a `ReactNode`, which is what keeps `@unimatrix/chrome` free of
 * `@unimatrix/auth`.
 */

const DEFAULT_OWNER_NAME = "Gwen Phalan";
const STICKY_BAR_TOP_OFFSET = 12;

export type PublicBreadcrumbItem = {
  label: string;
  /** Omitted for the current page, which renders as text rather than a link. */
  to?: string;
};

/**
 * Narrower than the icon libraries' own prop types on purpose: this is the only
 * surface the shell actually uses, and typing it structurally means a consumer
 * can pass a Remix icon, a Lucide icon, or its own SVG component without this
 * package taking a dependency on any of them.
 */
// The `| undefined` on each prop is required, not noise. `ComponentType`
// admits class components, and under `exactOptionalPropertyTypes` a class's
// `defaultProps` is checked against this shape — so an icon library whose props
// are `Booleanish | undefined` (Remix icons are) fails to assign unless the
// target accepts `undefined` too.
export type PublicNavIcon = React.ComponentType<{
  "aria-hidden"?: boolean | "true" | "false" | undefined;
  className?: string | undefined;
}>;

export type PublicNavItem = {
  /** Resolved by the app — it owns the route matching rules. */
  active: boolean;
  icon: PublicNavIcon;
  label: string;
  to: string;
  onMouseEnter?: () => void;
  onFocus?: () => void;
};

export type PublicShellProps = {
  /** Rendered at the right of both header bars. Omit to render neither. */
  accountControl?: React.ReactNode;
  breadcrumbItems: PublicBreadcrumbItem[];
  children: React.ReactNode;
  /** Right-hand cluster of the footer. Use `PublicFooterLink` for the links. */
  footerLinks?: React.ReactNode;
  /** Accessible name of the logo link, which always routes to `/`. */
  homeLabel?: string;
  /** Served from the consuming app's public directory. */
  logoSrc?: string;
  navItems: PublicNavItem[];
  /** Name in the footer's copyright line. */
  ownerName?: string;
  /** Renders the footer's "© year owner" line. Defaults to `true`; set to `false` to omit it. */
  showCopyright?: boolean;
  /**
   * Rendered last, inside the page container and out of the column's flow.
   * Exists for app-owned overlays that must sit inside the shell rather than
   * beside it — `apps/web` mounts its admin toast host here.
   */
  trailing?: React.ReactNode;
};

export function PublicPageContainer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-[100dvh] w-full max-w-[92rem] flex-col gap-8 px-4 py-4 sm:px-6 lg:gap-10 lg:px-8 lg:py-6 xl:px-10",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Link in the site footer. Exists so a service adds its own contact and profile
 * links without re-deriving the icon spacing and hover treatment.
 */
export function PublicFooterLink({ className, ...props }: React.ComponentProps<"a">) {
  return (
    <a
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function PublicSiteFooter({
  links,
  ownerName,
  showCopyright,
}: {
  links: React.ReactNode | undefined;
  ownerName: string;
  showCopyright: boolean;
}) {
  const year = new Date().getFullYear();

  return (
    <footer className="site-panel site-shell overflow-hidden px-5 py-5 lg:px-8 lg:py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {showCopyright ? (
          <p className="text-xs text-muted-foreground">
            © {year} {ownerName}.
          </p>
        ) : null}

        {links === undefined ? null : (
          <div className="flex flex-wrap items-center gap-4">{links}</div>
        )}
      </div>
    </footer>
  );
}

/**
 * Below `sm` only the leading crumb survives, so the narrow header reads as
 * the site name beside the logo rather than a trail — the nav tabs already
 * carry which page is current. Every segment stays in the DOM and is hidden
 * with a responsive class so this stays a pure CSS breakpoint rather than a
 * JS-measured one; hiding a whole segment takes its leading separator with
 * it, which is why no separator is left dangling on mobile.
 *
 * Rendered as a real `nav` landmark, with the home logo link inside it. It was
 * a plain `div` beside a bare `Link`, and in the condensed header — which is
 * not inside `header` — that left both outside any landmark, which is what
 * axe's `region` rule reports. `nav[aria-label="Breadcrumb"]` is also just the
 * correct markup for a breadcrumb trail.
 *
 * `label` exists because both header bars render one of these, and two
 * landmarks sharing a role and an accessible name is exactly what
 * `landmark-unique` reports.
 */
function Breadcrumbs({
  homeLabel,
  items,
  label,
  logoClassName,
  logoSrc,
}: {
  homeLabel: string;
  items: PublicBreadcrumbItem[];
  label: string;
  logoClassName: string;
  logoSrc: string;
}) {
  return (
    <nav
      aria-label={label}
      // `flex-nowrap` is load-bearing. The logo and the trail live in one flex
      // line; letting that line wrap drops the logo onto a row of its own at
      // 640-768px, where the trail is long enough to need the space. Measured:
      // with `flex-wrap` here the header's breadcrumb grew from 24px to 102px
      // tall at 640px and the trail broke across three lines.
      className="flex min-w-0 flex-1 flex-nowrap items-center gap-2.5 text-sm text-muted-foreground"
    >
      <Link aria-label={homeLabel} to="/">
        <img alt="" className={logoClassName} src={logoSrc} />
      </Link>
      {/* `flex-nowrap` here too, not just on the `nav`. Wrapping was moved onto
          this span when the logo-drop was fixed, which kept the logo in place
          but let the trail stack instead: at 640-768px "Unimatrix-01" and
          "> Home" sat on two rows beside a `shrink-0` logo.

          This is now a backstop rather than the fix. The header gives the nav
          its own row below `lg`, so the trail has the width it needs and never
          reaches the point of stacking; keeping `flex-nowrap` means a longer
          trail added later degrades by truncating the crumb labels — which
          already carry `truncate`, with `min-w-0` on every ancestor so the
          shrink reaches them — rather than by silently growing the header. */}
      <span className="flex min-w-0 flex-nowrap items-center gap-1">
        {items.map((item, index) => {
          // The root crumb links home on every route, including ones that add
          // no crumb of their own (`/admin`). Trailing crumbs are plain text
          // because they are the current page, but the root never is — leaving
          // it as text on a one-crumb route made the site name stop being a way
          // back.
          const isPlainText = item.to === undefined || (index > 0 && index === items.length - 1);

          return (
            <span
              className={cn(
                "flex min-w-0 items-center gap-1",
                index === 0 ? undefined : "hidden sm:flex",
              )}
              key={`${item.to ?? "current"}:${item.label}:${index}`}
            >
              {index > 0 ? (
                <RiArrowRightSLine aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
              {isPlainText || item.to === undefined ? (
                <span className="truncate font-medium text-foreground">{item.label}</span>
              ) : (
                <Link className="truncate transition-colors hover:text-foreground" to={item.to}>
                  {item.label}
                </Link>
              )}
            </span>
          );
        })}
      </span>
    </nav>
  );
}

function PublicNav({
  className,
  iconClassName,
  items,
  itemClassName,
  label,
}: {
  className: string;
  iconClassName: string;
  items: PublicNavItem[];
  itemClassName: (active: boolean) => string;
  label: string;
}) {
  return (
    <nav aria-label={label} className={className}>
      {items.map(({ active, icon: Icon, label: itemLabel, to, onMouseEnter, onFocus }) => (
        <Link
          aria-current={active ? "page" : undefined}
          className={itemClassName(active)}
          key={to}
          onMouseEnter={onMouseEnter}
          onFocus={onFocus}
          to={to}
        >
          <Icon aria-hidden="true" className={iconClassName} />
          <span>{itemLabel}</span>
        </Link>
      ))}
    </nav>
  );
}

function PublicShellContent({
  accountControl,
  breadcrumbItems,
  children,
  footerLinks,
  homeLabel,
  logoSrc,
  navItems,
  ownerName,
  showCopyright,
  trailing,
}: Required<Pick<PublicShellProps, "breadcrumbItems" | "children" | "navItems" | "ownerName">> & {
  accountControl: React.ReactNode | undefined;
  footerLinks: React.ReactNode | undefined;
  homeLabel: string;
  logoSrc: string;
  showCopyright: boolean;
  trailing: React.ReactNode | undefined;
}) {
  const headerRef = useRef<HTMLElement | null>(null);
  const [isCondensed, setIsCondensed] = useState(false);

  useEffect(() => {
    const updateCollapsedState = () => {
      const headerBottom = headerRef.current?.getBoundingClientRect().bottom ?? 0;

      setIsCondensed(headerBottom <= STICKY_BAR_TOP_OFFSET);
    };

    updateCollapsedState();
    window.addEventListener("scroll", updateCollapsedState, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateCollapsedState);
    };
  }, []);

  return (
    <PublicPageContainer>
      <GraphBackground />

      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border focus:border-primary/45 focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
        href="#main-content"
      >
        Skip to main content
      </a>

      <header className="site-panel site-shell overflow-hidden" ref={headerRef}>
        {/* One flex line that wraps instead of two nested clusters: below
            `lg` the nav is pushed to its own row by `w-full` + `order-last`,
            which leaves the title row free for the auth action. DOM order
            stays title → nav → auth so desktop tab order matches what's on
            screen.

            The nav keeps its own row all the way to `lg`, not just to `sm`.
            Between 640 and 1023px the four tabs plus the auth action leave the
            breadcrumb no width to live in, and forcing all of it onto one line
            does not fix that — it only changes how the trail fails. Measured
            against a real build at 700px: with the row shared, the trail either
            stacked ("Unimatrix-01" over "› Home", the reported bug) or, once
            wrapping was disabled, truncated to "U… › C". Giving the nav its own
            row below `lg` is what lets the full trail render untruncated at
            every width, at the cost of a two-row header in that band. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 lg:flex-nowrap lg:px-8 lg:py-5">
          <Breadcrumbs
            homeLabel={homeLabel}
            items={breadcrumbItems}
            label="Breadcrumb"
            logoClassName="size-6 shrink-0"
            logoSrc={logoSrc}
          />

          <PublicNav
            className="order-last grid w-full grid-cols-2 gap-2 sm:flex sm:w-full sm:flex-wrap sm:justify-end lg:w-auto lg:order-none"
            itemClassName={(active) =>
              cn(
                "inline-flex w-full items-center justify-center gap-2 border px-3 py-1.5 text-sm font-medium transition-[border-color,background-color,color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary/45 sm:w-auto",
                active
                  ? "border-primary/45 bg-primary/12 text-foreground"
                  : "border-border bg-secondary/60 text-foreground/75 hover:border-primary/35 hover:bg-secondary hover:text-foreground",
              )
            }
            iconClassName="size-3.5"
            items={navItems}
            label="Primary"
          />

          {accountControl === undefined ? null : (
            <div className="flex shrink-0 items-center justify-end gap-2">{accountControl}</div>
          )}
        </div>
      </header>

      {/* `opacity-0 pointer-events-none` hides this bar from sight and from
          the mouse, but not from the keyboard: before `inert`, tabbing an
          unscrolled page walked an invisible duplicate of the entire nav.
          `inert` removes it from the tab order and the accessibility tree
          while it is hidden, and gives it back — fully interactive — the
          moment it is shown. `aria-hidden` alone would be wrong here: it
          hides content from assistive technology while leaving it focusable,
          which is a WCAG 4.1.2 failure rather than a fix. */}
      {/* Not shown on a phone. Its nav stacks two-up below `lg`, so the bar
          lands about 110px tall over an 844px viewport — an eighth of the
          screen, permanently, sitting on top of whatever is being read. The
          header it condenses is one scroll away, which is where a phone
          expects to find it. `hidden` also keeps it out of the tab order at
          those widths, so the `inert` toggle below still describes the only
          case where it exists. */}
      <div
        className={cn(
          "fixed top-3 inset-x-0 z-40 hidden transition-opacity duration-300 ease-out sm:block",
          isCondensed ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
        inert={!isCondensed}
      >
        <div className="mx-auto w-full max-w-[92rem] px-4 sm:px-6 lg:px-8 xl:px-10">
          <div className="site-panel site-shell overflow-hidden border-primary/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent),0_18px_48px_-32px_color-mix(in_oklab,var(--primary)_35%,transparent)] px-3 py-2 lg:px-4 lg:py-2">
            {/* Switching this bar's nav breakpoint to `sm` was tried and
                reverted: at 640px the full breadcrumb, four tabs, and the auth
                action do not fit this fixed overlay, and the trail is squeezed
                down to "Uni… > B… > P…". Below `lg` the nav is `order-last
                w-full`, so the auth action sits on the title row at every
                stacked width. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:flex-nowrap">
              <Breadcrumbs
                homeLabel={homeLabel}
                items={breadcrumbItems}
                label="Breadcrumb, condensed header"
                logoClassName="size-5 shrink-0"
                logoSrc={logoSrc}
              />

              <PublicNav
                className="order-last grid w-full grid-cols-2 gap-2 lg:flex lg:w-auto lg:flex-wrap lg:justify-end lg:order-none"
                itemClassName={(active) =>
                  cn(
                    "inline-flex w-full items-center justify-center gap-2 border px-3 py-1 text-sm font-medium transition-[border-color,background-color,color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary/45 lg:w-auto",
                    active
                      ? "border-primary/45 bg-primary/12 text-foreground"
                      : "border-border/70 bg-background/72 text-muted-foreground hover:border-primary/35 hover:text-foreground",
                  )
                }
                iconClassName="size-4"
                items={navItems}
                label="Primary, condensed header"
              />

              {accountControl === undefined ? null : (
                <div className="flex shrink-0 items-center justify-end gap-2">{accountControl}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <main id="main-content" className="-mt-4 grid flex-1 gap-8 lg:-mt-5 lg:gap-10">
        {children}
      </main>

      <PublicSiteFooter links={footerLinks} ownerName={ownerName} showCopyright={showCopyright} />

      {/* Taken out of flow. A host that renders a zero-height element is still
          a zero-height *flex item*, and it earns the column's `gap-10` — which
          is how an admin saw 40px of dead space under the footer that nobody
          else did. */}
      {trailing === undefined ? null : <div className="absolute">{trailing}</div>}
    </PublicPageContainer>
  );
}

export function PublicShell({
  accountControl,
  breadcrumbItems,
  children,
  footerLinks,
  homeLabel = "Unimatrix-01 home",
  logoSrc = "/logo.png",
  navItems,
  ownerName = DEFAULT_OWNER_NAME,
  showCopyright = true,
  trailing,
}: PublicShellProps) {
  return (
    <PublicShellContent
      accountControl={accountControl}
      breadcrumbItems={breadcrumbItems}
      footerLinks={footerLinks}
      homeLabel={homeLabel}
      logoSrc={logoSrc}
      navItems={navItems}
      ownerName={ownerName}
      showCopyright={showCopyright}
      trailing={trailing}
    >
      {children}
    </PublicShellContent>
  );
}
