import type { ReactNode } from "react";
import { useMemo } from "react";
import { useRouterState } from "@tanstack/react-router";
import {
  RiArticleLine,
  RiFolderLine,
  RiGithubLine,
  RiHome5Line,
  RiMailLine,
  RiUserLine,
} from "@remixicon/react";
import type { PublicBreadcrumbItem, PublicNavItem } from "@unimatrix/chrome/public";
import { PublicFooterLink, PublicShell } from "@unimatrix/chrome/public";

import { emailAddress, githubProfileUrl } from "@/features/public-site/site-links";

type AppShellProps = {
  children: ReactNode;
};

/**
 * Which routes exist and how a path maps onto a tab stays here rather than in
 * `@unimatrix/chrome`: the package renders the frame, the app owns the route
 * knowledge. `exact` is consumed by `isNavItemActive` below and never leaves
 * this file — the shell receives an already-resolved `active` flag.
 */
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

function isNavItemActive(pathname: string, exact: boolean, to: (typeof navItems)[number]["to"]) {
  return exact ? pathname === to : pathname.startsWith(to);
}

/**
 * Contact and profile links for the site footer. Site data, not chrome, so the
 * shell takes them as a slot the same way it would take an account control.
 */
function SiteFooterLinks() {
  return (
    <>
      <PublicFooterLink href={`mailto:${emailAddress}`}>
        <RiMailLine aria-hidden="true" className="size-3.5" />
        {emailAddress}
      </PublicFooterLink>
      <PublicFooterLink href={githubProfileUrl} rel="noreferrer" target="_blank">
        <RiGithubLine aria-hidden="true" className="size-3.5" />
        github.com/gwenphalan
      </PublicFooterLink>
    </>
  );
}

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  /**
   * Title of the entry the detail routes loaded, used by the breadcrumb.
   *
   * Read from the active match's loader data rather than from a slug lookup:
   * entries live in the database now, so the shell has no synchronous index to
   * consult, and the detail route has already resolved exactly this entry. The
   * breadcrumb falls back to the slug while the loader is still in flight.
   */
  const activeEntryTitle = useRouterState({
    select: (state) => {
      for (const match of state.matches) {
        const loaderData = match.loaderData as { frontmatter?: { title?: unknown } } | undefined;
        const title = loaderData?.frontmatter?.title;

        if (typeof title === "string") {
          return title;
        }
      }

      return undefined;
    },
  });

  const breadcrumbItems = useMemo(() => {
    const items: PublicBreadcrumbItem[] = [{ label: "Unimatrix-01", to: "/" }];

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

      items.push({ label: "Projects", to: "/projects" });
      items.push({ label: activeEntryTitle ?? slug });
      return items;
    }

    if (pathname === "/blog") {
      items.push({ label: "Blog" });
      return items;
    }

    if (pathname.startsWith("/blog/")) {
      const slug = pathname.replace("/blog/", "");

      items.push({ label: "Blog", to: "/blog" });
      items.push({ label: activeEntryTitle ?? slug });
      return items;
    }

    return items;
  }, [activeEntryTitle, pathname]);

  const shellNavItems = useMemo<PublicNavItem[]>(
    () =>
      navItems.map(({ exact, icon, label, to }) => ({
        active: isNavItemActive(pathname, exact, to),
        icon,
        label,
        to,
      })),
    [pathname],
  );

  return (
    <PublicShell
      breadcrumbItems={breadcrumbItems}
      footerLinks={<SiteFooterLinks />}
      navItems={shellNavItems}
    >
      {children}
    </PublicShell>
  );
}
