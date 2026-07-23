import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { RiGithubLine, RiLoaderLine, RiMailLine } from "@remixicon/react";

import { Badge, Card, cn } from "@unimatrix/ui/public";

import { projectLiveStatusQueryOptions } from "./queries/check-project-live-status";
import { emailAddress, githubProfileUrl } from "./site-links";

export function PublicPageContainer({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-[100dvh] w-full max-w-[92rem] flex-col gap-8 px-4 py-4 sm:px-6 lg:gap-10 lg:px-8 lg:py-6 xl:px-10",
        className,
      )}
      {...props}
    />
  );
}

export function PublicSiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-panel site-shell overflow-hidden px-5 py-5 lg:px-8 lg:py-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          © {year} Gwen Phalan.
        </p>

        <div className="flex flex-wrap items-center gap-4">
          <a
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={`mailto:${emailAddress}`}
          >
            <RiMailLine aria-hidden="true" className="size-3.5" />
            {emailAddress}
          </a>
          <a
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            href={githubProfileUrl}
            rel="noreferrer"
            target="_blank"
          >
            <RiGithubLine aria-hidden="true" className="size-3.5" />
            github.com/gwenphalan
          </a>
        </div>
      </div>
    </footer>
  );
}

export function PublicSectionHeading({
  badges,
  className,
  description,
  descriptionClassName,
  title,
  titleClassName,
  trailing,
}: {
  badges?: React.ReactNode;
  className?: string;
  description?: React.ReactNode;
  descriptionClassName?: string;
  title?: React.ReactNode;
  titleClassName?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid gap-3 border-b border-border/70 pb-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end",
        className,
      )}
    >
      <div className="space-y-3">
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        {title ? (
          <h2
            className={cn(
              "max-w-5xl text-2xl leading-[0.96] font-medium tracking-[-0.05em] text-foreground lg:text-3xl",
              titleClassName,
            )}
          >
            {title}
          </h2>
        ) : null}
        {description ? (
          <p
            className={cn(
              "max-w-3xl text-sm leading-7 text-muted-foreground lg:text-[0.95rem] lg:leading-7",
              descriptionClassName,
            )}
          >
            {description}
          </p>
        ) : null}
      </div>

      {trailing ? <div className="flex items-end justify-end">{trailing}</div> : null}
    </div>
  );
}

export function PublicContentParagraphs({
  className,
  columns = 1,
  paragraphs,
}: {
  className?: string;
  columns?: 1 | 2;
  paragraphs: string[];
}) {
  return (
    <div className={cn("grid gap-4", columns === 2 && "lg:grid-cols-2", className)}>
      {paragraphs.map((paragraph, index) => (
        <div key={`${index}:${paragraph}`} className="site-panel px-5 py-4">
          <p className="text-sm leading-7 text-foreground/86 lg:text-[0.95rem] lg:leading-7">
            {paragraph}
          </p>
        </div>
      ))}
    </div>
  );
}

type PublicCardLinkRenderer = (props: {
  ariaLabel: string;
  children: React.ReactNode;
  className: string;
}) => React.ReactElement;

function PublicLinkedSurface({
  actions,
  children,
  className,
  linkLabel,
  renderLink,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  linkLabel?: string;
  renderLink?: PublicCardLinkRenderer;
}) {
  const interactive = Boolean(renderLink);
  const overlay = renderLink
    ? renderLink({
        ariaLabel: linkLabel ?? "Open item",
        children: <span className="sr-only">{linkLabel}</span>,
        className: "absolute inset-0 z-10 outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
      })
    : undefined;

  return (
    <Card
      className={cn(
        "site-panel site-panel-strong relative overflow-hidden",
        interactive &&
          "transition-[border-color,background-color,transform,box-shadow] duration-200 hover:border-primary/45 hover:bg-secondary/26 hover:-translate-y-0.5 focus-within:border-primary/50 focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]",
        className,
      )}
    >
      {overlay}
      <div className={cn("space-y-4 px-5 py-4", interactive && "pointer-events-none relative z-10")}>{children}</div>
      {actions ? (
        <div className={cn("flex flex-wrap gap-3 px-5 pb-4", interactive && "pointer-events-auto relative z-20")}>
          {actions}
        </div>
      ) : null}
    </Card>
  );
}

export function PublicDecisionCard({
  detail,
  eyebrow,
  renderLink,
  summary,
  title,
}: {
  detail: React.ReactNode;
  eyebrow: React.ReactNode;
  renderLink: PublicCardLinkRenderer;
  summary: React.ReactNode;
  title: string;
}) {
  return (
    <PublicLinkedSurface linkLabel={`Open ${title}`} renderLink={renderLink}>
      <div className="space-y-2.5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground">{eyebrow}</p>
        <h3 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.65rem]">
          {title}
        </h3>
        <p className="text-sm leading-7 text-foreground/86">{summary}</p>
      </div>
      <div className="border-t border-border/60 pt-3 text-sm leading-7 text-muted-foreground">{detail}</div>
    </PublicLinkedSurface>
  );
}

type PublicProjectCardData = {
  excerpt: string;
  frontmatter: {
    liveUrl?: string;
    publishedAt: string;
    repoUrl?: string;
    status: string;
    summary: string;
    title: string;
  };
  slug: string;
};

function getProjectStatusClassName(status: string) {
  switch (status.toLowerCase()) {
    case "active":
      return "border-primary/35 bg-primary/16 text-foreground";
    case "in-progress":
      return "border-chart-2/35 bg-chart-2/14 text-foreground";
    case "standby":
      return "border-border bg-secondary/55 text-foreground";
    default:
      return "border-border/70 bg-background/60 text-foreground";
  }
}

export function ProjectStatusBadge({
  frontmatter,
}: {
  frontmatter: Pick<PublicProjectCardData["frontmatter"], "liveUrl" | "status">;
}) {
  const { liveUrl, status } = frontmatter;
  const liveStatusQuery = useQuery({
    ...projectLiveStatusQueryOptions(liveUrl ?? ""),
    enabled: liveUrl !== undefined,
  });

  if (liveUrl === undefined) {
    return (
      <Badge className={cn("border", getProjectStatusClassName(status))}>{status}</Badge>
    );
  }

  if (liveStatusQuery.isPending) {
    return (
      <Badge className="gap-1.5" variant="outline">
        <RiLoaderLine aria-hidden="true" className="size-3 animate-spin" />
        Checking
      </Badge>
    );
  }

  const isLive = liveStatusQuery.data === "live";

  return (
    <Badge
      className={cn(
        "gap-1.5 border",
        isLive
          ? "border-primary/35 bg-primary/16 text-foreground"
          : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", isLive ? "bg-primary" : "bg-destructive")}
      />
      {isLive ? "Live" : "Offline"}
    </Badge>
  );
}

export function PublicProjectLedgerItem({
  actions,
  index,
  project,
  renderLink,
}: {
  actions?: React.ReactNode;
  index: number;
  project: PublicProjectCardData;
  renderLink?: PublicCardLinkRenderer;
}) {
  const linkProps = renderLink
    ? {
        linkLabel: `Open project ${project.frontmatter.title}`,
        renderLink,
      }
    : {};

  return (
    <PublicLinkedSurface
      actions={actions}
      className="h-full overflow-hidden"
      {...linkProps}
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectStatusBadge frontmatter={project.frontmatter} />
            <span className="text-xs text-muted-foreground">{project.frontmatter.publishedAt}</span>
          </div>
          <h3 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.5rem]">
            {project.frontmatter.title}
          </h3>
          <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-[0.95rem] lg:leading-7">
            {project.frontmatter.summary}
          </p>
        </div>

        <p className="hidden text-2xl leading-none font-medium tracking-[-0.06em] text-muted-foreground/50 lg:block lg:text-[1.7rem]">
          {String(index).padStart(2, "0")}
        </p>
      </div>
    </PublicLinkedSurface>
  );
}

type PublicPostListItemData = {
  excerpt: string;
  frontmatter: {
    description?: string;
    publishedAt: string;
    summary: string;
    title: string;
  };
  slug: string;
};

export function PublicTransmissionListItem({
  entry,
  index,
  renderLink,
}: {
  entry: PublicPostListItemData;
  index: number;
  renderLink?: PublicCardLinkRenderer;
}) {
  const summary = entry.frontmatter.description ?? entry.frontmatter.summary;
  const linkProps = renderLink
    ? {
        linkLabel: `Open blog entry ${entry.frontmatter.title}`,
        renderLink,
      }
    : {};

  return (
    <PublicLinkedSurface className="h-full overflow-hidden" {...linkProps}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="space-y-2.5">
          <span className="text-xs text-muted-foreground">{entry.frontmatter.publishedAt}</span>
          <h3 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.5rem]">
            {entry.frontmatter.title}
          </h3>
          <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-[0.95rem] lg:leading-7">
            {summary}
          </p>
        </div>

        <p className="hidden text-2xl leading-none font-medium tracking-[-0.06em] text-muted-foreground/50 lg:block lg:text-[1.7rem]">
          {String(index).padStart(2, "0")}
        </p>
      </div>
    </PublicLinkedSurface>
  );
}

export function PublicMetadataStrip({
  items,
}: {
  items: Array<{
    label: React.ReactNode;
    value: React.ReactNode;
  }>;
}) {
  return (
    <dl className="grid gap-px overflow-hidden border border-border/70 bg-border/70 md:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <div key={index} className="bg-background px-4 py-3.5">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="mt-2 text-sm leading-7 text-foreground/88">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function PublicReadingFrame({
  children,
  title,
}: {
  children: React.ReactNode;
  title: React.ReactNode;
}) {
  return (
    <article className="reading-frame">
      <div className="border-b border-border/60 pb-4">
        <h2 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.65rem]">
          {title}
        </h2>
      </div>
      <div className="pt-5">{children}</div>
    </article>
  );
}
