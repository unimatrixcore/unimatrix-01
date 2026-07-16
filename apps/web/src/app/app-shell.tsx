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
import { PublicPageContainer, PublicSiteFooter } from "@/features/public-site/components";
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
    to: "/" as const,
  },
  {
    exact: false,
    icon: RiFolderLine,
    label: "Projects",
    to: "/projects" as const,
  },
  {
    exact: false,
    icon: RiArticleLine,
    label: "Blog",
    to: "/blog" as const,
  },
  {
    exact: false,
    icon: RiUserLine,
    label: "About",
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
      items.push({ label: "Blog" });
      return items;
    }

    if (pathname.startsWith("/blog/")) {
      const slug = pathname.replace("/blog/", "");
      const entry = getBlogEntryBySlug(slug);

      items.push({ label: "Blog", to: "/blog" });
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
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 lg:px-8 lg:py-5">
          <Breadcrumbs items={breadcrumbItems} />

          <nav aria-label="Primary" className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            {navItems.map(({ icon: Icon, label, to, exact }) => {
              const active = isNavItemActive(pathname, exact, to);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex w-full items-center justify-center gap-2 border px-3 py-1.5 text-sm font-medium transition-[border-color,background-color,color] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary/45 sm:w-auto",
                    active
                      ? "border-primary/45 bg-primary/12 text-foreground"
                      : "border-border/70 bg-background/72 text-muted-foreground hover:border-primary/35 hover:text-foreground",
                  )}
                  key={to}
                  to={to}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </nav>
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
        <div className="mx-auto w-full max-w-[92rem] px-4 sm:px-6 lg:px-8 xl:px-10">
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

      <main id="main-content" className="-mt-4 grid flex-1 gap-8 lg:-mt-5 lg:gap-10">
        {children}
      </main>

      <PublicSiteFooter />
    </PublicPageContainer>
  );
}
