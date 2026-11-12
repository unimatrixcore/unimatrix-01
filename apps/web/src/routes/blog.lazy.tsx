import { InstantVirtualList, useBackgroundList } from "@unimatrix/instant-list";
import { toBlogEntry } from "@/features/content/entries";
import { publishedBackgroundPostsOptions } from "@/features/content/queries/background-posts";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import {
  PublicNotice,
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";

export const Route = createLazyFileRoute("/blog")({
  component: BlogRoute,
  errorComponent: BlogUnavailable,
});

function BlogRoute() {
  const list = useBackgroundList(publishedBackgroundPostsOptions("blog"));
  const entries = list.items.map(toBlogEntry);
  if (list.isPending)
    return (
      <PublicNotice
        label="Loading"
        title="Loading blog"
        description="Fetching the first records."
      />
    );
  if (list.isError && list.items.length === 0) return <BlogUnavailable />;

  return (
    <div className="space-y-5">
      <PublicSectionHeading headingLevel={1} title="Blog" />

      {entries.length === 0 ? (
        <PublicNotice
          description="Nothing is published here yet. Check back once the first entry goes up."
          label="No posts yet"
          title="The blog is empty."
        />
      ) : (
        <InstantVirtualList
          items={entries}
          getItemId={(entry) => entry.slug}
          rowHeight={220}
          measureRows
          height="min(70vh, 760px)"
          ariaLabel="Blog posts"
          error={list.error}
          onRetry={list.onEndReached}
          onEndReached={list.onEndReached}
          hasNextPage={list.hasNextPage}
          isFetching={list.isFetching}
          renderItem={(entry, index) => (
            <div className="grid gap-3 pb-3" key={entry.slug}>
              <PublicTransmissionListItem
                headingLevel={2}
                entry={entry}
                index={index + 1}
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
      )}
    </div>
  );
}

/**
 * Posts are fetched from the API, so an unreachable API is a real state this
 * page has to render.
 */
function BlogUnavailable() {
  return (
    <div className="space-y-5">
      <PublicSectionHeading headingLevel={1} title="Blog" />

      <PublicNotice
        description="The blog could not be loaded right now. Reload the page to try again."
        label="Unavailable"
        title="Posts could not be loaded."
        tone="destructive"
      />
    </div>
  );
}
