import type * as React from "react";

import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card } from "./ui/card.js";
import { Separator } from "./ui/separator.js";
import { cn } from "../lib/utils.js";

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
        "mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-6 py-6 lg:px-10 lg:py-8",
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
    <Card className="border-border/60 bg-card/88 shadow-[0_28px_100px_-44px_color-mix(in_oklab,var(--foreground)_28%,transparent)] backdrop-blur">
      <div className="grid gap-6 px-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-4">
          {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.32em] text-muted-foreground">
              public-site content surface
            </p>
            <h1 className="max-w-4xl text-3xl leading-tight font-medium tracking-tight lg:text-5xl">
              {title}
            </h1>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
              {description}
            </p>
          </div>
        </div>

        <div className="grid gap-3 self-start">
          <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.28em] text-muted-foreground">
            <span>{navigationHeading}</span>
            {navigationAdornment}
          </div>
          <nav aria-label={navigationAriaLabel} className="grid gap-2">
            {navigationItems.map((item) => (
              <Button
                key={item.key}
                asChild
                className={cn(
                  "w-full justify-start gap-2 shadow-none",
                  !item.active && "bg-card/70",
                )}
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
          <Separator className="mt-6" />
          <div className="grid gap-3 px-6 text-xs leading-6 text-muted-foreground lg:grid-cols-3">
            {footerItems.map((item, index) => (
              <p key={index}>{item}</p>
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
  const titleContent = title ? (
    <h2 className={cn("text-2xl leading-tight font-medium tracking-tight", titleClassName)}>
      {title}
    </h2>
  ) : null;

  const descriptionContent = description ? (
    <p
      className={cn(
        "max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base",
        descriptionClassName,
      )}
    >
      {description}
    </p>
  ) : null;

  const headingContent = (
    <div className="space-y-3">
      {titleContent}
      {descriptionContent}
    </div>
  );
  const hasHeadingContent = Boolean(titleContent || descriptionContent);
  const badgesContent = badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null;

  return (
    <div className={cn("space-y-4", className)}>
      {badgesContent && trailing ? (
        <div className="flex items-center justify-between gap-3">
          {badgesContent}
          {trailing}
        </div>
      ) : badgesContent ? (
        badgesContent
      ) : trailing ? (
        <div className="flex items-start justify-between gap-3">
          {headingContent}
          {trailing}
        </div>
      ) : (
        null
      )}
      {hasHeadingContent && !(trailing && !badgesContent) ? headingContent : null}
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
        <p key={`${index}:${paragraph}`} className="text-sm leading-7 text-muted-foreground lg:text-base">
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
        "space-y-4",
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
    ? "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30"
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
          "relative space-y-2 border border-border/60 bg-card/70 px-3 py-3 ring-1 ring-foreground/10",
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
        "relative border-border/60 bg-card/88 shadow-none",
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
        <Badge>{project.frontmatter.status}</Badge>
        <Badge variant="outline">{project.frontmatter.publishedAt}</Badge>
        {variant === "default" ? <Badge variant="secondary">{project.slug}</Badge> : null}
      </div>
      <div className="space-y-2">
        <h3
          className={cn(
            "font-medium tracking-tight",
            variant === "default" ? "text-xl leading-tight" : "text-sm leading-6",
          )}
        >
          {project.frontmatter.title}
        </h3>
        <p className="text-sm leading-7 text-muted-foreground">{project.frontmatter.summary}</p>
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
        <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
        {variant === "default" ? <Badge variant="secondary">{entry.slug}</Badge> : null}
      </div>
      <div className="space-y-2">
        <h3
          className={cn(
            "font-medium tracking-tight",
            variant === "default" ? "text-xl leading-tight" : "text-sm leading-6",
          )}
        >
          {entry.frontmatter.title}
        </h3>
        <p className="text-sm leading-7 text-muted-foreground">{summary}</p>
        {variant === "default" ? (
          <p className="text-sm leading-7 text-muted-foreground">{entry.excerpt}</p>
        ) : null}
      </div>
    </PublicCardSurface>
  );
}
