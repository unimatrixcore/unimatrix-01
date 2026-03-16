import { createFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiStackLine } from "@remixicon/react";

import { blogEntries } from "@/features/content/site-content";
import { Badge, Button, Card } from "@unimatrix/ui";

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
              Repo-backed blog entries now flow through the shared content package.
            </h2>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
              This route is intentionally a small listing surface for LOC-43: it proves the
              typed content boundary without expanding into a full publishing system yet.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4">
        {entries.map((entry) => (
          <Card key={entry.slug} className="border-border/60 bg-card/88 shadow-none">
            <div className="space-y-4 px-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
                <Badge variant="secondary">{entry.filePath}</Badge>
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
              <Button asChild variant="outline" className="w-fit gap-2">
                <a href={`#${entry.slug}`}>
                  Baseline entry only
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}