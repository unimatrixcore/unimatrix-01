import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiStackLine } from "@remixicon/react";

import {
  PublicPostListItem,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { Badge, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/blog")({
  component: BlogRoute,
});

function BlogRoute() {
  const entries = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiStackLine aria-hidden="true" className="size-3.5" />
                  Transmission archive
                </Badge>
                <Badge variant="outline">Typed collection</Badge>
              </>
            }
            description="Writing stays compact on purpose: architecture notes, implementation reports, and field transmissions that can survive a reread later."
            title="Logs are published when the signal is precise enough to keep."
          />

          <div className="grid gap-3 self-start">
            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Archive counts</p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Total transmissions</dt>
                  <dd>{entries.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Most recent</dt>
                  <dd>{entries[0]?.frontmatter.publishedAt ?? "n/a"}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Renderer</dt>
                  <dd>safe markdown</dd>
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
