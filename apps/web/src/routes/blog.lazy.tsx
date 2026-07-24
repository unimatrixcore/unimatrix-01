import { Link, createLazyFileRoute } from "@tanstack/react-router";

import {
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";

export const Route = createLazyFileRoute("/blog")({
  component: BlogRoute,
});

function BlogRoute() {
  const entries = Route.useLoaderData();

  return (
    <div className="space-y-5">
      <PublicSectionHeading
        title="Blog"
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
