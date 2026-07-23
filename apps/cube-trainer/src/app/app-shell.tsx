import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";

import { AppFooter, AppPageContainer } from "@/features/cube-trainer-site/components";
import { cn } from "@unimatrix/ui/public";

type AppShellProps = {
  children: ReactNode;
};

const navItems = [
  { label: "OLL", to: "/oll" as const },
  { label: "PLL", to: "/pll" as const },
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

      <header className="flex items-center justify-between gap-4 py-1">
        <Link
          aria-label="Cube Trainer home"
          className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
          to="/"
        >
          <img alt="" className="size-4 shrink-0 opacity-80" src="/favicon.svg" />
          <span className="text-xs font-medium tracking-[-0.01em]">Cube Trainer</span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-4">
          {navItems.map(({ label, to }) => {
            const active = pathname.startsWith(to);

            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={cn(
                  "text-xs font-medium tracking-[-0.01em] transition-colors outline-none focus-visible:underline",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
                key={to}
                to={to}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="grid flex-1 gap-8 lg:gap-10" id="main-content">
        {children}
      </main>

      <AppFooter />
    </AppPageContainer>
  );
}
