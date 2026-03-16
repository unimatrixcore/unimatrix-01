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
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-4 px-6">
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiStackLine aria-hidden="true" className="size-3.5" />
                  Blog
                </Badge>
                <Badge variant="outline">typed collection</Badge>
              </>
            }
            description="Public v1 keeps the blog intentionally small: durable project and architecture notes stay, while one-off queue-status updates are left out of the main narrative."
            title="Selected writing now carries forward the parts of the legacy blog that still fit the new site."
          />
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
