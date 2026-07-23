import type { ReactNode } from "react";

import { AppFooter, AppPageContainer } from "@/features/cube-trainer-site/components";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <AppPageContainer>
      <a
        className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:border focus:border-primary/45 focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
        href="#main-content"
      >
        Skip to main content
      </a>

      <main className="flex flex-1 flex-col justify-center gap-8 lg:gap-10" id="main-content">
        {children}
      </main>

      <AppFooter />
    </AppPageContainer>
  );
}
