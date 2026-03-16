import { createFileRoute } from "@tanstack/react-router";
import { RiStackLine } from "@remixicon/react";

import { blogEntries } from "@/features/content/site-content";
import { Badge, Card } from "@unimatrix/ui";

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
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5">
              <RiStackLine aria-hidden="true" className="size-3.5" />
              Blog
            </Badge>
            <Badge variant="outline">typed collection</Badge>
          </div>
          <div className="space-y-3">
            <h2 className="text-2xl leading-tight font-medium tracking-tight">
              Selected writing now carries forward the parts of the legacy blog that still fit the new site.
            </h2>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
              Public v1 keeps the blog intentionally small: durable project and architecture notes stay,
              while one-off queue-status updates are left out of the main narrative.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4">
        {entries.map((entry) => (
          <Card id={entry.slug} key={entry.slug} className="border-border/60 bg-card/88 shadow-none">
            <div className="space-y-4 px-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
                <Badge variant="secondary">{entry.slug}</Badge>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl leading-tight font-medium tracking-tight">
                  {entry.frontmatter.title}
                </h3>
                <p className="text-sm leading-7 text-muted-foreground">
                  {entry.frontmatter.description ?? entry.frontmatter.summary}
                </p>
                <p className="text-sm leading-7 text-muted-foreground">{entry.excerpt}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}