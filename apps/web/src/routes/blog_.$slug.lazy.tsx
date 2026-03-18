import { RiArrowLeftLine, RiStackLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import { Badge, Button, Card, Separator } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/blog_/$slug")({
  component: BlogDetailRoute,
  notFoundComponent: BlogNotFound,
});

function BlogDetailRoute() {
  const entry = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <article className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiStackLine aria-hidden="true" className="size-3.5" />
                Transmission detail
              </Badge>
              <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
            </div>

            <div className="space-y-3">
              <p className="borg-data-label">Log / blog/{entry.slug}</p>
              <h2 className="max-w-4xl text-3xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-5xl">
                {entry.frontmatter.title}
              </h2>
              <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-base lg:leading-8">
                {entry.frontmatter.description ?? entry.frontmatter.summary}
              </p>
            </div>

            <Button asChild className="w-fit gap-2" variant="outline">
              <Link to="/blog">
                <RiArrowLeftLine aria-hidden="true" className="size-4" />
                Back to transmission archive
              </Link>
            </Button>
          </article>

          <aside className="grid gap-3 self-start xl:sticky xl:top-6">
            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Transmission metadata</p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Slug</dt>
                  <dd>{entry.slug}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Published</dt>
                  <dd>{entry.frontmatter.publishedAt}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Description</dt>
                  <dd>{entry.frontmatter.description ? "present" : "summary only"}</dd>
                </div>
              </dl>
            </div>

            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Rendering mode</p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Safe markdown stays active here too, with router-aware internal links and no raw
                HTML execution path.
              </p>
            </div>
          </aside>
        </div>
      </Card>

      <Card className="borg-panel overflow-hidden">
        <div className="space-y-6 px-6 py-6">
          <div className="space-y-2">
            <p className="borg-data-label">Transmission body</p>
            <h3 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
              Authored record
            </h3>
          </div>

          <Separator className="border-primary/15" />

          <LazyPublicMarkdown
            markdown={entry.body}
            renderInternalLink={renderPublicMarkdownInternalLink}
          />
        </div>
      </Card>
    </div>
  );
}

function BlogNotFound() {
  return (
    <Card className="borg-panel overflow-hidden">
      <div className="space-y-4 px-6 py-6">
        <Badge variant="destructive">Transmission unavailable</Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That transmission is not part of the current archive.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
            Return to the archive to review the entries that are presently online.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/blog">Browse transmissions</Link>
        </Button>
      </div>
    </Card>
  );
}
