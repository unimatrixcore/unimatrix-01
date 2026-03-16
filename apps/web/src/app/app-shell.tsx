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
    <div className="min-h-screen">
      <PublicPageContainer>
        <PublicAppFrame
          badges={
            <>
              <Badge className="gap-1.5">
                <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                LOC-43
              </Badge>
              <Badge variant="outline">Typed content baseline</Badge>
              <Badge variant="secondary">Repo-backed markdown</Badge>
            </>
          }
          description={homeContent.frontmatter.intro}
          footerItems={[
            "Home, project, and blog copy now resolve from repo-backed content files instead of route-local placeholder strings.",
            "`apps/web` consumes `@unimatrix/content` for parsing and typed contracts while the UI remains in `@unimatrix/ui`.",
            "Borg Markdown stays future work; this baseline keeps markdown safe and non-executable for the first public-site surface.",
          ]}
          navigationAdornment={<RiStackLine aria-hidden="true" className="size-4" />}
          navigationAriaLabel="Scaffold navigation"
          navigationItems={navigationItems}
          title={homeContent.frontmatter.title}
        />

        <main className="grid gap-6">{children}</main>
      </PublicPageContainer>
    </div>
  );
}
