import type { ReactNode } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiArticleLine,
  RiArrowRightSLine,
  RiFolderLine,
  RiHome5Line,
  RiUserLine,
} from "@remixicon/react";

import {
  getBlogEntryBySlug,
  getProjectEntryBySlug,
} from "@/features/content/site-content";
import { PublicPageContainer } from "@/features/public-site/components";
import { cn } from "@unimatrix/ui/public";

type AppShellProps = {
  children: ReactNode;
};

const STICKY_BAR_TOP_OFFSET = 12;

const navItems = [
  {
    exact: true,
    icon: RiHome5Line,
    label: "Home",
    routeCode: "01",
    routeSummary: "Overview, featured work, and recent writing.",
    to: "/" as const,
  },
  {
    exact: false,
    icon: RiFolderLine,
    label: "Projects",
    routeCode: "02",
    routeSummary: "Selected builds, current status, and deeper project notes.",
    to: "/projects" as const,
  },
  {
    exact: false,
    icon: RiArticleLine,
    label: "Writing",
    routeCode: "03",
    routeSummary: "Posts, implementation notes, and longer-form thinking.",
    to: "/blog" as const,
  },
  {
    exact: false,
    icon: RiUserLine,
    label: "About",
    routeCode: "04",
    routeSummary: "Background, contact details, and a simple way to reach out.",
    to: "/about" as const,
  },
];

type BreadcrumbItem = {
  label: string;
  to?: "/" | "/about" | "/projects" | "/blog";
};

function isNavItemActive(pathname: string, exact: boolean, to: (typeof navItems)[number]["to"]) {
  return exact ? pathname === to : pathname.startsWith(to);
}

function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <Fragment key={`${item.to ?? "current"}:${item.label}:${index}`}>
            {index > 0 ? <RiArrowRightSLine aria-hidden="true" className="size-3.5 shrink-0" /> : null}
            {isLast || !item.to ? (
              <span className="truncate font-medium text-foreground">{item.label}</span>
            ) : (
              <Link className="truncate transition-colors hover:text-foreground" to={item.to}>
                {item.label}
              </Link>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

export function AppShell({ children }: AppShellProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const [isCondensed, setIsCondensed] = useState(false);
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

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

  const breadcrumbItems = useMemo(() => {
    const items: BreadcrumbItem[] = [{ label: "Unimatrix-01", to: "/" }];

    if (pathname === "/") {
      items.push({ label: "Home" });
      return items;
    }

    if (pathname === "/about") {
      items.push({ label: "About" });
      return items;
    }

    if (pathname === "/projects") {
      items.push({ label: "Projects" });
      return items;
    }

    if (pathname.startsWith("/projects/")) {
      const slug = pathname.replace("/projects/", "");
      const project = getProjectEntryBySlug(slug);

      items.push({ label: "Projects", to: "/projects" });
      items.push({ label: project?.frontmatter.title ?? slug });
      return items;
    }

    if (pathname === "/blog") {
      items.push({ label: "Writing" });
      return items;
    }

    if (pathname.startsWith("/blog/")) {
      const slug = pathname.replace("/blog/", "");
      const entry = getBlogEntryBySlug(slug);

      items.push({ label: "Writing", to: "/blog" });
      items.push({ label: entry?.frontmatter.title ?? slug });
      return items;
    }

    return items;
  }, [pathname]);

  return (
    <PublicPageContainer>
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border focus:border-primary/45 focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
        href="#main-content"
      >
        Skip to main content
      </a>

      <header className="site-panel site-shell overflow-hidden" ref={headerRef}>
        <div className="grid gap-8 px-5 py-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,30rem)] lg:px-8 lg:py-7">
          <div className="space-y-4">
            <Breadcrumbs items={breadcrumbItems} />

            <div className="space-y-3">
              <div className="max-w-3xl space-y-3">
                <p className="text-3xl leading-[0.94] font-medium tracking-[-0.06em] text-foreground lg:text-[3.35rem]">
                  Gwenny Phalan
                </p>
                <p className="max-w-2xl text-sm leading-7 text-foreground/86 lg:text-[0.95rem] lg:leading-7">
                  Gwenny is a jack of all trades, master of none, with a graveyard of unfinished
                  TypeScript/Web, game dev, video editing, writing, and filmmaking projects.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 self-start sm:grid-cols-2">
            {navItems.map(({ icon: Icon, label, routeCode, to, exact }) => {
              const active = isNavItemActive(pathname, exact, to);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  key={to}
                  className={cn(
                    "site-atlas-link group flex min-h-24 items-center justify-between gap-4 border px-4 py-4 outline-none transition-[border-color,background-color,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-secondary/26 focus-visible:ring-2 focus-visible:ring-primary/45",
                    active
                      ? "border-primary/45 bg-primary/10 text-foreground"
                      : "border-border/70 bg-background/70 text-foreground/84",
                  )}
                  to={to}
                >
                  <div className="flex min-w-0 items-center gap-4">
                    <span className="site-label">{routeCode}</span>
                    <p className="truncate text-lg leading-tight font-medium tracking-[-0.04em] text-foreground">
                      {label}
                    </p>
                  </div>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                </Link>
              );
            })}
          </div>
        </div>
      </header>

      <div
        className={cn(
          "fixed top-3 inset-x-0 z-40 transition-opacity duration-300 ease-out",
          isCondensed
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <div className="mx-auto w-full max-w-[108rem] px-4 sm:px-6 lg:px-8 xl:px-10">
          <div className="site-panel site-shell overflow-hidden border-primary/45 shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent),0_18px_48px_-32px_color-mix(in_oklab,var(--primary)_35%,transparent)] px-3 py-2 lg:px-4 lg:py-2">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <Breadcrumbs items={breadcrumbItems} />

              <nav
                aria-label="Primary"
                className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:justify-end"
              >
                {navItems.map(({ icon: Icon, label, to, exact }) => {
                  const active = isNavItemActive(pathname, exact, to);

                  return (
                      <Link
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex w-full items-center justify-center gap-2 border px-3 py-1 text-sm font-medium transition-[border-color,background-color,color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary/45 lg:w-auto",
                          active
                            ? "border-primary/45 bg-primary/12 text-foreground"
                            : "border-border/70 bg-background/72 text-muted-foreground hover:border-primary/35 hover:text-foreground",
                      )}
                      key={to}
                      to={to}
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      <span>{label}</span>
                    </Link>
                  );
                })}
              </nav>
            </div>
          </div>
        </div>
      </div>

      <main id="main-content" className="-mt-4 grid gap-8 lg:-mt-5 lg:gap-10">
        {children}
      </main>
    </PublicPageContainer>
  );
}
