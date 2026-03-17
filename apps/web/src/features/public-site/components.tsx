import type * as React from "react";

import { Badge, Button, Card, Separator, cn } from "@unimatrix/ui";

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
        "mx-auto flex min-h-screen w-full max-w-[108rem] flex-col gap-8 px-4 py-4 sm:px-6 lg:px-8 lg:py-6 xl:px-10",
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
  navigationHeading = "Content routes",
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
    <Card className="border border-border/70 bg-background/60 shadow-[0_40px_140px_-72px_color-mix(in_oklab,var(--foreground)_80%,transparent)] backdrop-blur-xl">
      <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-7">
          {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="space-y-4">
              <p className="text-[0.68rem] uppercase tracking-[0.36em] text-primary/80">
                Ops console // public surface
              </p>
              <h1 className="max-w-5xl text-4xl leading-[0.94] font-medium tracking-[-0.06em] lg:text-6xl">
                {title}
              </h1>
              <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
                {description}
              </p>
            </div>

            <div className="grid gap-3 self-start border border-border/70 bg-background/45 px-4 py-4">
              <div className="flex items-center justify-between gap-3 text-[0.68rem] uppercase tracking-[0.28em] text-muted-foreground">
                <span>Signal frame</span>
                {navigationAdornment}
              </div>
              <p className="text-sm leading-7 text-foreground/88">
                Repo-backed authored content, safe GitHub-flavored markdown, and typed route
                contracts are now the live public path.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 self-start">
          <div className="flex items-center justify-between gap-3 text-[0.68rem] uppercase tracking-[0.28em] text-muted-foreground">
            <span>{navigationHeading}</span>
          </div>
          <nav aria-label={navigationAriaLabel} className="grid gap-2">
            {navigationItems.map((item) => (
              <Button
                key={item.key}
                asChild
                className={cn(
                  "h-auto w-full justify-start border px-4 py-3 text-left text-[0.72rem] uppercase tracking-[0.26em] shadow-none [&_svg]:size-4",
                  item.active
                    ? "border-primary/40 bg-primary/16 text-foreground"
                    : "border-border/70 bg-background/45 text-muted-foreground hover:bg-secondary/55 hover:text-foreground",
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
          <Separator className="mt-2" />
          <div className="grid gap-3 px-6 text-xs leading-6 text-muted-foreground md:grid-cols-2 xl:grid-cols-3">
            {footerItems.map((item, index) => (
              <div
                key={index}
                className="border border-border/60 bg-background/35 px-4 py-3"
              >
                <p className="text-[0.68rem] uppercase tracking-[0.28em] text-muted-foreground">
                  0{index + 1}
                </p>
                <p className="mt-3">{item}</p>
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
    <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]", className)}>
      <div className="space-y-4">
        {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
        {title ? (
          <h2
            className={cn(
              "text-2xl leading-[1] font-medium tracking-[-0.05em] text-foreground lg:text-4xl",
              titleClassName,
            )}
          >
            {title}
          </h2>
        ) : null}
        {description ? (
          <p
            className={cn(
              "max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base",
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
          className="border border-border/60 bg-background/35 px-4 py-4 text-sm leading-7 text-muted-foreground lg:text-base"
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
        variant === "default" ? "px-6" : undefined,
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
    ? "transition-all duration-200 hover:-translate-y-1 hover:border-primary/45 hover:bg-secondary/20 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/25"
    : undefined;

  const link = renderLink
    ? renderLink({
        ariaLabel: linkLabel,
        children: <span className="sr-only">{linkLabel}</span>,
        className: "absolute inset-0 z-10 outline-none",
      })
    : undefined;

  if (variant === "compact") {
    return (
      <div
        id={id}
        className={cn(
          "relative space-y-2 border border-border/70 bg-background/45 px-4 py-4 ring-1 ring-foreground/10",
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
    <Card
      id={id}
      className={cn(
        "relative border border-border/70 bg-background/50 shadow-[0_30px_110px_-74px_color-mix(in_oklab,var(--foreground)_70%,transparent)]",
        interactiveClasses,
        className,
      )}
    >
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
        <Badge variant="outline">Project</Badge>
        <Badge>{project.frontmatter.status}</Badge>
        <Badge variant="secondary">{project.frontmatter.publishedAt}</Badge>
      </div>
      <div className="space-y-3">
        <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
          /{project.slug}
        </p>
        <h3
          className={cn(
            "font-medium tracking-[-0.04em] text-foreground",
            variant === "default" ? "text-2xl leading-tight" : "text-base leading-6",
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
        <Badge variant="outline">Log</Badge>
        <Badge variant="secondary">{entry.frontmatter.publishedAt}</Badge>
      </div>
      <div className="space-y-3">
        <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
          /{entry.slug}
        </p>
        <h3
          className={cn(
            "font-medium tracking-[-0.04em] text-foreground",
            variant === "default" ? "text-2xl leading-tight" : "text-base leading-6",
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
