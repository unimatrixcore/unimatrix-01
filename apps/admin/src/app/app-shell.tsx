import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ToolShell } from "@unimatrix/chrome/tool";

import { AccountControl } from "@/features/auth/account-control";

import { useAdminSections } from "./sections";

type AppShellProps = {
  children: ReactNode;
};

/**
 * The admin app's chrome.
 *
 * It is a **tool** surface, not a content surface, so it takes
 * `@unimatrix/chrome`'s `./tool` shell: a collapsible section rail, dense
 * content region, no site nav tabs and no site footer. That split is
 * tool-vs-content rather than signed-in-vs-public (see the root `AGENTS.md`),
 * and an admin console is the clearest case on the tool side.
 *
 * `sections` is non-empty, so the shell renders the rail rather than a title
 * bar: the wordmark and `accountControl` move into it. `showFooter={false}`
 * turns off the footer entirely, which was the only place `homeHref` (the
 * absolute public-site URL) reached the page in this layout — the rail's
 * wordmark links `sectionsHomeHref` instead, so there is deliberately no way
 * back to the public site from admin chrome; `homeHref` is omitted rather
 * than passed and unused.
 */
export function AppShell({ children }: AppShellProps) {
  const sections = useAdminSections();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <ToolShell
      accountControl={({ collapsed }) => <AccountControl collapsed={collapsed} />}
      homeLabel="Unimatrix Admin"
      scroll={
        pathname === "/content" ||
        pathname.startsWith("/content/") ||
        pathname === "/secrets" ||
        pathname === "/secrets/"
          ? "section"
          : "page"
      }
      sections={sections}
      width="wide"
      sectionsHomeHref="/"
      showFooter={false}
    >
      {children}
    </ToolShell>
  );
}
