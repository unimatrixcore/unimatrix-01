import { Link, createFileRoute } from "@tanstack/react-router";
import { RiStackLine } from "@remixicon/react";

import { blogEntries } from "@/features/content/site-content";
import { Badge, Card, PublicPostListItem, PublicSectionHeading } from "@unimatrix/ui";

export const Route = createFileRoute("/blog")({
  component: BlogRoute,
  loader: () => blogEntries,
});

function BlogRoute() {
  const entries = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="border border-border/70 bg-background/56 shadow-[0_32px_120px_-76px_color-mix(in_oklab,var(--foreground)_72%,transparent)] backdrop-blur-xl">
        <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiStackLine aria-hidden="true" className="size-3.5" />
                  Blog archive
                </Badge>
                <Badge variant="outline">typed collection</Badge>
              </>
            }
            description="Public writing stays intentionally tight: durable notes, architecture context, and migration rationale only. The route reads like an archive surface instead of a generic feed."
            title="Selected writing now sits inside a typed, repo-backed archive."
          />

          <div className="grid gap-3 self-start">
            <div className="border border-border/70 bg-background/40 px-4 py-4">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                Archive counts
              </p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Total entries</dt>
                  <dd>{entries.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Most recent</dt>
                  <dd>{entries[0]?.frontmatter.publishedAt ?? "n/a"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Renderer</dt>
                  <dd>safe GFM</dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-4">
        {entries.map((entry) => (
          <PublicPostListItem
            id={entry.slug}
            key={entry.slug}
            entry={entry}
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
    </div>
  );
}
