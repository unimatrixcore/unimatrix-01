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
    <div className="space-y-5">
      <PublicSectionHeading
        badges={
          <Badge className="gap-1.5">
            <RiArticleLine aria-hidden="true" className="size-3.5" />
            Blog
          </Badge>
        }
        description="Posts, notes, and technical write-ups in chronological order."
        title="Blog archive"
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
    </div>
  );
}
