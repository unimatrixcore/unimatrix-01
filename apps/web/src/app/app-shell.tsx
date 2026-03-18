import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiBroadcastLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { homeContent } from "@/features/content/site-content";
import {
  PublicAppFrame,
  PublicPageContainer,
  type PublicAppFrameNavigationItem,
} from "@/features/public-site/components";
import { Badge } from "@unimatrix/ui/public";

type AppShellProps = {
  children: ReactNode;
};

const navItems = [
  {
    exact: true,
    icon: RiBroadcastLine,
    label: "Node",
    to: "/" as const,
  },
  {
    exact: false,
    icon: RiLayoutGridLine,
    label: "Projects",
    to: "/projects" as const,
  },
  {
    exact: false,
    icon: RiStackLine,
    label: "Transmissions",
    to: "/blog" as const,
  },
  {
    exact: false,
    icon: RiPulseLine,
    label: "Status",
    to: "/status" as const,
  },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const navigationItems: PublicAppFrameNavigationItem[] = navItems.map(
    ({ exact, icon: Icon, label, to }) => ({
      active: exact ? pathname === to : pathname.startsWith(to),
      content: (
        <Link className="flex w-full items-center gap-2" to={to}>
          <Icon aria-hidden="true" className="size-4" />
          {label}
        </Link>
      ),
      key: to,
    }),
  );

  return (
    <PublicPageContainer>
      <PublicAppFrame
        badges={
          <>
            <Badge className="gap-1.5">
              <RiBroadcastLine aria-hidden="true" className="size-3.5" />
              Collective interface
            </Badge>
            <Badge variant="outline">Repo-backed content</Badge>
            <Badge variant="secondary">Safe markdown only</Badge>
          </>
        }
        description={homeContent.frontmatter.intro}
        footerItems={[
          homeContent.frontmatter.summary,
          homeContent.frontmatter.mission,
          "TypeScript, Node.js, cybersecurity study, and open-source system design remain the active signal cluster.",
        ]}
        navigationAdornment={<RiPulseLine aria-hidden="true" className="size-4 text-primary" />}
        navigationAriaLabel="Site navigation"
        navigationHeading="System navigation"
        navigationItems={navigationItems}
        title="UNIMATRIX-01 // NODE: GWENNY"
      />

      <main className="grid gap-6 lg:gap-8">{children}</main>
    </PublicPageContainer>
  );
}
