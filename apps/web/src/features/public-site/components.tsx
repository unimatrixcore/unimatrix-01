import type * as React from "react";

import { Badge, Button, Card, Separator, cn } from "@unimatrix/ui/public";

export interface PublicAppFrameNavigationItem {
  active?: boolean;
  content: React.ReactElement;
  key: string;
}

export function PublicPageContainer({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative mx-auto flex min-h-screen w-full max-w-[116rem] flex-col gap-8 px-4 py-4 sm:px-6 lg:px-8 lg:py-6 xl:px-10",
        className,
      )}
      {...props}
    />
  );
}

export function PublicAppFrame({
  badges,
  description,
  footerItems = [],
  navigationAdornment,
  navigationAriaLabel = "Site navigation",
  navigationHeading = "System navigation",
  navigationItems,
  title,
}: {
  badges?: React.ReactNode;
  description: React.ReactNode;
  footerItems?: React.ReactNode[];
  navigationAdornment?: React.ReactNode;
  navigationAriaLabel?: string;
  navigationHeading?: React.ReactNode;
  navigationItems: PublicAppFrameNavigationItem[];
  title: React.ReactNode;
}) {
  return (
    <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/80">
      <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1.35fr)_22rem]">
        <div className="space-y-6">
          {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}

          <div className="space-y-4">
            <p className="borg-section-kicker">Public node</p>
            <h1 className="max-w-5xl text-4xl leading-[0.9] font-medium tracking-[-0.08em] text-foreground sm:text-5xl lg:text-6xl">
              {title}
            </h1>
            <p className="max-w-3xl text-sm leading-7 text-foreground/86 lg:text-base lg:leading-8">
              {description}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="borg-subpanel px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <span className="borg-data-label">Collective link</span>
                {navigationAdornment}
              </div>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Backend systems, security study, and worldbuilding signals converge here through a
                single public node.
              </p>
            </div>

            <div className="borg-subpanel px-4 py-4">
              <span className="borg-data-label">Surface contract</span>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Repo-backed markdown, explicit registries, and safe rendering keep this interface
                inspectable under load.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 self-start">
          <div className="flex items-center justify-between gap-3">
            <span className="borg-data-label">{navigationHeading}</span>
            <span aria-hidden="true" className="borg-status-led" />
          </div>

          <nav aria-label={navigationAriaLabel} className="grid gap-2">
            {navigationItems.map((item) => (
              <Button
                key={item.key}
                asChild
                className={cn(
                  "h-auto w-full justify-start border px-4 py-3 text-left text-[0.72rem] uppercase tracking-[0.24em] shadow-none transition-colors [&_svg]:size-4",
                  item.active
                    ? "border-primary/40 bg-primary/18 text-foreground hover:bg-primary/20"
                    : "border-border/70 bg-background/50 text-muted-foreground hover:border-primary/30 hover:bg-secondary/45 hover:text-foreground",
                )}
                size="lg"
                variant={item.active ? "default" : "outline"}
              >
                {item.content}
              </Button>
            ))}
          </nav>
        </div>
      </div>

      {footerItems.length > 0 ? (
        <>
          <Separator className="border-primary/15" />
          <div className="grid gap-3 px-6 pb-6 md:grid-cols-2 xl:grid-cols-3">
            {footerItems.map((item, index) => (
              <div key={index} className="borg-subpanel px-4 py-4">
                <p className="borg-data-label">0{index + 1}</p>
                <p className="mt-3 text-sm leading-7 text-foreground/84">{item}</p>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Card>
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
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start", className)}>
      <div className="space-y-4">
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        {title ? (
          <h2
            className={cn(
              "max-w-4xl text-2xl leading-[0.94] font-medium tracking-[-0.06em] text-foreground lg:text-4xl",
              titleClassName,
            )}
          >
            {title}
          </h2>
        ) : null}
        {description ? (
          <p
            className={cn(
              "max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8",
              descriptionClassName,
            )}
          >
            {description}
          </p>
        ) : null}
      </div>

      {trailing ? <div className="flex items-start justify-end">{trailing}</div> : null}
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
        <p
          key={`${index}:${paragraph}`}
          className="borg-subpanel px-4 py-4 text-sm leading-7 text-foreground/84 lg:text-base lg:leading-8"
        >
          {paragraph}
        </p>
      ))}
    </div>
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

type PublicCardLinkRenderer = (props: {
  ariaLabel: string;
  children: React.ReactNode;
  className: string;
}) => React.ReactElement;

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

function PublicCardSurface({
  actions,
  children,
  className,
  id,
  linkLabel,
  renderLink,
  variant,
}: (
  | {
      actions?: React.ReactNode | undefined;
      children: React.ReactNode;
      className?: string | undefined;
      id?: string | undefined;
      linkLabel: string;
      renderLink: PublicCardLinkRenderer;
      variant: "compact" | "default";
    }
  | {
      actions?: React.ReactNode | undefined;
      children: React.ReactNode;
      className?: string | undefined;
      id?: string | undefined;
      linkLabel?: undefined;
      renderLink?: undefined;
      variant: "compact" | "default";
    }
)) {
  const isInteractive = Boolean(renderLink);
  const content = (
    <div
      className={cn(
        "space-y-5",
        variant === "default" ? "px-5 py-5 sm:px-6 sm:py-6" : "px-4 py-4",
        isInteractive ? "pointer-events-none relative z-10" : undefined,
      )}
    >
      {children}
      {actions ? (
        <div
          className={cn(
            "flex flex-wrap gap-3",
            isInteractive ? "pointer-events-auto relative z-20" : undefined,
          )}
        >
          {actions}
        </div>
      ) : null}
    </div>
  );

  const interactiveClasses = isInteractive
    ? "transition-[transform,border-color,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-secondary/36 focus-within:border-primary/50 focus-within:shadow-[0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
    : undefined;

  const link = renderLink
    ? renderLink({
        ariaLabel: linkLabel,
        children: <span className="sr-only">{linkLabel}</span>,
        className: "absolute inset-0 z-10 outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
      })
    : undefined;

  if (variant === "compact") {
    return (
      <div
        id={id}
        className={cn(
          "borg-subpanel relative overflow-hidden",
          interactiveClasses,
          className,
        )}
      >
        {link}
        {content}
      </div>
    );
  }

  return (
    <Card id={id} className={cn("borg-panel relative overflow-hidden", interactiveClasses, className)}>
      {link}
      {content}
    </Card>
  );
}

export function PublicProjectCard({
  actions,
  className,
  project,
  renderLink,
  variant = "default",
}: {
  actions?: React.ReactNode | undefined;
  className?: string | undefined;
  project: PublicProjectCardData;
  renderLink?: PublicCardLinkRenderer | undefined;
  variant?: "compact" | "default";
}) {
  const linkProps = renderLink
    ? {
        linkLabel: `Open project ${project.frontmatter.title}`,
        renderLink,
      }
    : {};

  return (
    <PublicCardSurface
      actions={actions}
      className={className}
      variant={variant}
      {...linkProps}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Project node</Badge>
        <Badge className={cn("border", getProjectStatusClassName(project.frontmatter.status))}>
          {project.frontmatter.status}
        </Badge>
        <Badge variant="secondary">{project.frontmatter.publishedAt}</Badge>
      </div>

      <div className="space-y-3">
        <p className="borg-data-label">Designation / {project.slug}</p>
        <h3
          className={cn(
            "font-medium tracking-[-0.05em] text-foreground",
            variant === "default" ? "text-2xl leading-tight" : "text-lg leading-6",
          )}
        >
          {project.frontmatter.title}
        </h3>
        <p className="text-sm leading-7 text-foreground/88">{project.frontmatter.summary}</p>
        {variant === "default" ? (
          <p className="text-sm leading-7 text-muted-foreground">{project.excerpt}</p>
        ) : null}
      </div>
    </PublicCardSurface>
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

export function PublicPostListItem({
  actions,
  className,
  entry,
  id,
  renderLink,
  variant = "default",
}: {
  actions?: React.ReactNode | undefined;
  className?: string | undefined;
  entry: PublicPostListItemData;
  id?: string | undefined;
  renderLink?: PublicCardLinkRenderer | undefined;
  variant?: "compact" | "default";
}) {
  const summary = entry.frontmatter.description ?? entry.frontmatter.summary;
  const linkProps = renderLink
    ? {
        linkLabel: `Open blog entry ${entry.frontmatter.title}`,
        renderLink,
      }
    : {};

  return (
    <PublicCardSurface
      actions={actions}
      className={className}
      id={id}
      variant={variant}
      {...linkProps}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">Transmission</Badge>
        <Badge variant="secondary">{entry.frontmatter.publishedAt}</Badge>
      </div>

      <div className="space-y-3">
        <p className="borg-data-label">Log / {entry.slug}</p>
        <h3
          className={cn(
            "font-medium tracking-[-0.05em] text-foreground",
            variant === "default" ? "text-2xl leading-tight" : "text-lg leading-6",
          )}
        >
          {entry.frontmatter.title}
        </h3>
        <p className="text-sm leading-7 text-foreground/88">{summary}</p>
        {variant === "default" ? (
          <p className="text-sm leading-7 text-muted-foreground">{entry.excerpt}</p>
        ) : null}
      </div>
    </PublicCardSurface>
  );
}
