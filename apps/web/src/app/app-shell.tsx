import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  RiCompassDiscoverLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { homeContent } from "@/features/content/site-content";
import {
  Badge,
  PublicAppFrame,
  PublicPageContainer,
  type PublicAppFrameNavigationItem,
} from "@unimatrix/ui";

type AppShellProps = {
  children: ReactNode;
};

const navItems = [
  {
    exact: true,
    icon: RiCompassDiscoverLine,
    label: "Overview",
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
    label: "Blog",
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
        <Link to={to}>
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
              <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
              Public v1
            </Badge>
            <Badge variant="outline">Repo-backed content</Badge>
            <Badge variant="secondary">Safe markdown</Badge>
          </>
        }
        description={homeContent.frontmatter.intro}
        footerItems={[
          "Projects and writing stay repo-backed so the public surface remains easy to inspect, review, and evolve.",
          "The web app uses shared content contracts and shared UI primitives from the monorepo instead of route-local placeholders.",
          "The first public release keeps markdown intentionally plain and non-executable while richer content tooling stays future work.",
        ]}
        navigationAdornment={<RiStackLine aria-hidden="true" className="size-4" />}
        navigationAriaLabel="Site navigation"
        navigationItems={navigationItems}
        title={homeContent.frontmatter.title}
      />

      <main className="grid gap-6">{children}</main>
    </PublicPageContainer>
  );
}
