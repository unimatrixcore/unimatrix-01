import { InstantVirtualList, useBackgroundList, usePrefetchList } from "@unimatrix/instant-list";
import { toBlogEntry, toProjectEntry } from "@/features/content/entries";
import { publishedBackgroundPostsOptions } from "@/features/content/queries/background-posts";
import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiArticleLine, RiFolderLine } from "@remixicon/react";

import {
  PublicNotice,
  PublicProjectLedgerItem,
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";
import { homeContent } from "@/features/content/site-content";
import { Badge, Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
  errorComponent: HomeUnavailable,
});

function IndexRoute() {
  const blog = useBackgroundList({
    ...publishedBackgroundPostsOptions("blog"),
    maxBackgroundItems: 50,
  });
  const featured = useBackgroundList(publishedBackgroundPostsOptions("project", true));
  const projects = featured.items.map(toProjectEntry);
  const blogEntries = blog.items.slice(0, 2).map(toBlogEntry);
  const home = homeContent;
  const projectIntent = usePrefetchList(publishedBackgroundPostsOptions("project"));
  const blogIntent = usePrefetchList(publishedBackgroundPostsOptions("blog"));
  if (
    (blog.isError && blog.items.length === 0) ||
    (featured.isError && featured.items.length === 0)
  )
    return <HomeUnavailable />;

  return (
    <div className="space-y-8 lg:space-y-10">
      <section className="max-w-3xl space-y-4 lg:max-w-none">
        <h1 className="text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
          {home.frontmatter.title}
        </h1>
      </section>

      <div className="grid divide-y divide-border/70 xl:grid-cols-2 xl:items-stretch xl:gap-8 xl:divide-y-0">
        <section className="flex h-full flex-col gap-3 py-5 first:pt-0 last:pb-0 xl:py-0">
          <PublicSectionHeading
            badges={
              <Badge className="gap-1.5">
                <RiFolderLine aria-hidden="true" className="size-3.5" />
                Featured projects
              </Badge>
            }
            // No rule under a badge-only heading: with the title visually hidden
            // it separated the badge from the list it introduces rather than
            // the section from what came before.
            className="border-b-0 pb-0 sm:pb-0"
            title="Featured projects"
            titleClassName="sr-only"
          />

          <InstantVirtualList
            items={projects}
            getItemId={(project) => project.slug}
            rowHeight={230}
            measureRows
            height={480}
            ariaLabel="Featured projects"
            error={featured.error}
            onRetry={featured.onEndReached}
            onEndReached={featured.onEndReached}
            hasNextPage={featured.hasNextPage}
            isFetching={featured.isFetching}
            renderItem={(project, index) => (
              <div className="pb-3">
                <PublicProjectLedgerItem
                  index={index + 1}
                  key={project.slug}
                  project={project}
                  renderLink={({ ariaLabel, children, className }) => (
                    <Link
                      aria-label={ariaLabel}
                      className={className}
                      params={{ slug: project.slug }}
                      to="/projects/$slug"
                    >
                      {children}
                    </Link>
                  )}
                />
              </div>
            )}
          />

          <Button asChild className="w-fit gap-2" variant="outline">
            <Link to="/projects" {...projectIntent}>
              View all projects
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </section>

        <section className="flex h-full flex-col gap-3 py-5 first:pt-0 last:pb-0 xl:py-0">
          <PublicSectionHeading
            badges={
              <Badge className="gap-1.5">
                <RiArticleLine aria-hidden="true" className="size-3.5" />
                Recent blog posts
              </Badge>
            }
            // No rule under a badge-only heading: with the title visually hidden
            // it separated the badge from the list it introduces rather than
            // the section from what came before.
            className="border-b-0 pb-0 sm:pb-0"
            title="Recent blog posts"
            titleClassName="sr-only"
          />

          <InstantVirtualList
            items={blogEntries}
            getItemId={(entry) => entry.slug}
            rowHeight={230}
            measureRows
            height={480}
            ariaLabel="Recent blog posts"
            renderItem={(entry, index) => (
              <div className="pb-3">
                <PublicTransmissionListItem
                  entry={entry}
                  index={index + 1}
                  key={entry.slug}
                  renderLink={({ ariaLabel, children, className }) => (
                    <Link
                      aria-label={ariaLabel}
                      className={className}
                      params={{ slug: entry.slug }}
                      to="/blog/$slug"
                    >
                      {children}
                    </Link>
                  )}
                />
              </div>
            )}
          />

          <Button asChild className="w-fit gap-2" variant="outline">
            <Link to="/blog" {...blogIntent}>
              View all blog posts
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </section>
      </div>
    </div>
  );
}

/**
 * The homepage's two lists come from the API, but its heading does not —
 * `homeContent` is still compiled into the bundle. Rendering that much when
 * the API is unreachable keeps the page recognisably the site rather than a
 * bare error card.
 *
 * This is not cosmetic. Without an `errorComponent` the failure escapes to the
 * router's default, which replaces the root component and with it the
 * `<HeadContent />` that carries the meta description — the homepage then
 * ships without one, which is a Lighthouse SEO failure and a real crawler
 * regression, not just an ugly screen.
 */
function HomeUnavailable() {
  return (
    <div className="space-y-8 lg:space-y-10">
      <section className="max-w-3xl space-y-4 lg:max-w-none">
        <h1 className="text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
          {homeContent.frontmatter.title}
        </h1>
      </section>

      <PublicNotice
        action={
          <Button asChild className="w-fit gap-2" variant="outline">
            <Link to="/about">
              Read the about page
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        }
        description="Featured projects and recent posts could not be loaded right now. Reload the page to try again."
        label="Unavailable"
        title="The latest entries are not available."
        tone="destructive"
      />
    </div>
  );
}
