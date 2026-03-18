import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArticleLine } from "@remixicon/react";

import {
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";
import { Badge } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/blog")({
  component: BlogRoute,
});

function BlogRoute() {
  const entries = Route.useLoaderData();

  return (
    <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-9">
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <div className="space-y-3">
          <p className="site-label">Writing</p>
          <p className="text-sm leading-7 text-muted-foreground">
            A chronological archive for notes, articles, and implementation write-ups.
          </p>
        </div>

        <div className="site-panel px-5 py-4">
          <p className="site-label">Reading mode</p>
          <p className="mt-3 text-sm leading-7 text-foreground/88">
            Each entry surfaces the title, summary, and excerpt first so the archive stays easy to
            skim and easy to revisit.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="site-panel px-5 py-4">
            <p className="site-label">Total posts</p>
            <p className="mt-3 text-2xl leading-none font-medium tracking-[-0.06em] text-foreground">
              {entries.length}
            </p>
          </div>
          <div className="site-panel px-5 py-4">
            <p className="site-label">Latest post</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              {entries[0]?.frontmatter.publishedAt ?? "n/a"}
            </p>
          </div>
        </div>
      </aside>

      <section className="grid gap-4">
        <PublicSectionHeading
          badges={
            <>
              <Badge className="gap-1.5">
                <RiArticleLine aria-hidden="true" className="size-3.5" />
                Writing archive
              </Badge>
              <Badge variant="outline">Chronological</Badge>
            </>
          }
          description="Writing stays compact and ordered so older posts remain just as usable as new ones."
          title="Notes, essays, and technical write-ups"
        />

        <div className="grid gap-3">
          {entries.map((entry, index) => (
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
          ))}
        </div>
      </section>
    </div>
  );
}
