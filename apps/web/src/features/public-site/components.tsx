import type * as React from "react";

import { Badge, Card, cn } from "@unimatrix/ui/public";

export function PublicPageContainer({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-screen w-full max-w-[108rem] flex-col gap-8 px-4 py-4 sm:px-6 lg:gap-10 lg:px-8 lg:py-6 xl:px-10",
        className,
      )}
      {...props}
    />
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
              "max-w-5xl text-2xl leading-[0.96] font-medium tracking-[-0.05em] text-foreground lg:text-4xl",
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
        <p className="site-label">{eyebrow}</p>
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
      <div className="grid gap-5 lg:grid-cols-[3.5rem_minmax(0,1fr)_13rem] lg:items-start">
        <div className="space-y-2 border-b border-border/60 pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
          <p className="site-label">No.</p>
          <p className="text-2xl leading-none font-medium tracking-[-0.06em] text-foreground lg:text-[1.7rem]">
            {String(index).padStart(2, "0")}
          </p>
        </div>

        <div className="space-y-3.5">
          <div className="space-y-2.5">
            <p className="site-label">projects/{project.slug}</p>
            <h3 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.7rem]">
              {project.frontmatter.title}
            </h3>
            <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-[0.95rem] lg:leading-7">
              {project.frontmatter.summary}
            </p>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground">{project.excerpt}</p>
          </div>
        </div>

        <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm lg:border-t-0 lg:border-l lg:pl-5 lg:pt-0">
          <div>
            <dt className="site-label">Status</dt>
            <dd className="mt-1.5">
              <Badge className={cn("border", getProjectStatusClassName(project.frontmatter.status))}>
                {project.frontmatter.status}
              </Badge>
            </dd>
          </div>
          <div>
            <dt className="site-label">Published</dt>
            <dd className="mt-1.5 text-foreground/88">{project.frontmatter.publishedAt}</dd>
          </div>
          <div>
            <dt className="site-label">Repository</dt>
            <dd className="mt-1.5 text-foreground/88">
              {project.frontmatter.repoUrl ? "Linked" : "Pending"}
            </dd>
          </div>
          <div>
            <dt className="site-label">Format</dt>
            <dd className="mt-1.5 text-foreground/88">Write-up</dd>
          </div>
        </dl>
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
      <div className="grid gap-5 lg:grid-cols-[3.5rem_minmax(0,1fr)_13rem] lg:items-start">
        <div className="space-y-2 border-b border-border/60 pb-4 md:border-b-0 md:border-r md:pb-0 md:pr-5">
          <p className="site-label">Post</p>
          <p className="text-2xl leading-none font-medium tracking-[-0.06em] text-foreground lg:text-[1.7rem]">
            {String(index).padStart(2, "0")}
          </p>
        </div>

        <div className="space-y-2.5">
          <p className="site-label">blog/{entry.slug}</p>
          <h3 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.7rem]">
            {entry.frontmatter.title}
          </h3>
          <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-[0.95rem] lg:leading-7">
            {summary}
          </p>
          <p className="max-w-3xl text-sm leading-7 text-muted-foreground">{entry.excerpt}</p>
        </div>

        <dl className="grid gap-3 border-t border-border/60 pt-4 text-sm lg:border-t-0 lg:border-l lg:pl-5 lg:pt-0">
          <div>
            <dt className="site-label">Published</dt>
            <dd className="mt-1.5 text-foreground/88">{entry.frontmatter.publishedAt}</dd>
          </div>
          <div>
            <dt className="site-label">Format</dt>
            <dd className="mt-1.5 text-foreground/88">Article</dd>
          </div>
        </dl>
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
          <dt className="site-label">{item.label}</dt>
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
        <p className="site-label">Reading view</p>
        <h2 className="mt-2.5 text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-[1.65rem]">
          {title}
        </h2>
      </div>
      <div className="pt-5">{children}</div>
    </article>
  );
}
