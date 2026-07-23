import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiHome5Line,
  RiShieldUserLine,
  RiUserSettingsLine,
} from "@remixicon/react";

import { SignedIn, SignedOut, UserButton, usePermissions } from "@unimatrix/auth/react";
import { Button, cn } from "@unimatrix/ui/public";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { isAdmin } = usePermissions();

  const navItems = [
    { exact: true, icon: RiHome5Line, label: "Home", to: "/" as const },
    { exact: false, icon: RiUserSettingsLine, label: "Account", to: "/account" as const },
    ...(isAdmin()
      ? [{ exact: false, icon: RiShieldUserLine, label: "Admin", to: "/admin" as const }]
      : []),
  ];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
      <header className="site-panel site-shell overflow-hidden">
        <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 lg:px-8 lg:py-5">
          <Link aria-label="Unimatrix Accounts home" className="text-lg font-medium tracking-[-0.04em] text-foreground" to="/">
            Unimatrix Accounts
          </Link>

          <nav aria-label="Primary" className="flex flex-wrap items-center gap-2">
            {navItems.map(({ icon: Icon, label, to, exact }) => {
              const active = exact ? pathname === to : pathname.startsWith(to);

              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-2 border px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
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

            <SignedIn>
              <UserButton />
            </SignedIn>
            <SignedOut>
              <Button asChild size="sm" variant="outline">
                <Link to="/sign-in">Sign in</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/sign-up">Sign up</Link>
              </Button>
            </SignedOut>
          </nav>
        </div>
      </header>

      <main className="flex-1">{children}</main>
    </div>
  );
}
