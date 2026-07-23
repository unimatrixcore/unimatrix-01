import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { RiHome5Line, RiShapeLine, RiShapesLine } from "@remixicon/react";

import { AppFooter, AppPageContainer } from "@/features/cube-trainer-site/components";
import { cn } from "@unimatrix/ui/public";

type AppShellProps = {
  children: ReactNode;
};

const navItems = [
  { icon: RiHome5Line, label: "Home", to: "/" as const },
  { icon: RiShapeLine, label: "OLL", to: "/oll" as const },
  { icon: RiShapesLine, label: "PLL", to: "/pll" as const },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <AppPageContainer>
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border focus:border-primary/45 focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
        href="#main-content"
      >
        Skip to main content
      </a>

      <header className="site-panel site-shell sticky top-3 z-40 overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 lg:px-8 lg:py-5">
          <Link aria-label="Cube Trainer home" className="flex items-center gap-2.5" to="/">
            <img alt="" className="size-6 shrink-0" src="/favicon.svg" />
            <span className="text-sm font-medium tracking-[-0.02em] text-foreground">
              Cube Trainer
            </span>
          </Link>

          <nav aria-label="Primary" className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
            {navItems.map(({ icon: Icon, label, to }) => {
              const active = to === "/" ? pathname === to : pathname.startsWith(to);

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

      <main className="grid flex-1 gap-8 lg:gap-10" id="main-content">
        {children}
      </main>

      <AppFooter />
    </AppPageContainer>
  );
}
