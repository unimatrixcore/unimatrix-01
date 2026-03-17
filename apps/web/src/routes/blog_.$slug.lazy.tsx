import { RiArrowLeftLine, RiStackLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  Badge,
  Button,
  Card,
  Separator,
} from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/blog_/$slug")({
  component: BlogDetailRoute,
  notFoundComponent: BlogNotFound,
});

function BlogDetailRoute() {
  const entry = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="border border-border/70 bg-background/56 shadow-[0_34px_130px_-82px_color-mix(in_oklab,var(--foreground)_76%,transparent)] backdrop-blur-xl">
        <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <article className="space-y-8">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiStackLine aria-hidden="true" className="size-3.5" />
                Blog detail
              </Badge>
              <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
            </div>

            <div className="space-y-3">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                /blog/{entry.slug}
              </p>
              <h2 className="max-w-4xl text-3xl leading-[0.96] font-medium tracking-[-0.05em] lg:text-5xl">
                {entry.frontmatter.title}
              </h2>
              <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-base">
                {entry.frontmatter.description ?? entry.frontmatter.summary}
              </p>
            </div>

            <Button asChild variant="outline" className="w-fit gap-2">
              <Link to="/blog">
                <RiArrowLeftLine aria-hidden="true" className="size-4" />
                Back to blog
              </Link>
            </Button>

            <Separator />

            <LazyPublicMarkdown
              markdown={entry.body}
              renderInternalLink={renderPublicMarkdownInternalLink}
            />
          </article>

          <aside className="grid gap-3 self-start xl:sticky xl:top-6">
            <div className="border border-border/70 bg-background/40 px-4 py-4">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                Entry metadata
              </p>
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
                  <dd>{entry.frontmatter.description ? "set" : "summary only"}</dd>
                </div>
              </dl>
            </div>
            <div className="border border-border/70 bg-background/40 px-4 py-4">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                Renderer mode
              </p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Safe GFM with task lists, tables, blockquotes, links, and highlighted fenced
                code.
              </p>
            </div>
          </aside>
        </div>
      </Card>
    </div>
  );
}

function BlogNotFound() {
  return (
    <Card className="border border-border/70 bg-background/56 shadow-[0_32px_120px_-76px_color-mix(in_oklab,var(--foreground)_72%,transparent)] backdrop-blur-xl">
      <div className="space-y-4 px-6">
        <Badge variant="destructive">Blog route offline</Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.04em]">
            That blog entry slug is not part of the current public site.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
            Return to the blog archive to browse the published notes and architecture writing.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/blog">Browse the blog</Link>
        </Button>
      </div>
    </Card>
  );
}
