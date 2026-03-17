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
  PublicAppFrame,
  PublicPageContainer,
  type PublicAppFrameNavigationItem,
} from "@/features/public-site/components";
import {
  Badge,
} from "@unimatrix/ui/public";

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
              <RiCompassDiscoverLine aria-hidden="true" className="size-3.5" />
              Ops console
            </Badge>
            <Badge variant="outline">Repo-backed content</Badge>
            <Badge variant="secondary">Safe GFM active</Badge>
          </>
        }
        description={homeContent.frontmatter.intro}
        footerItems={[
          "Authored markdown stays repo-backed behind the explicit raw-import registry in apps/web so review and routing remain obvious.",
          "The web shell now renders safe GitHub-flavored markdown for authored content without enabling raw HTML or runtime MDX.",
          "Borg Markdown still matters, but it remains future parser work instead of part of this branch.",
        ]}
        navigationAdornment={<RiStackLine aria-hidden="true" className="size-4" />}
        navigationAriaLabel="Site navigation"
        navigationHeading="Route deck // live"
        navigationItems={navigationItems}
        title={homeContent.frontmatter.title}
      />

      <main className="grid gap-6 lg:gap-8">{children}</main>
    </PublicPageContainer>
  );
}
