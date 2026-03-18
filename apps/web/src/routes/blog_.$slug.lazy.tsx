import { RiArticleLine, RiArrowLeftLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  PublicMetadataStrip,
  PublicReadingFrame,
} from "@/features/public-site/components";
import { Badge, Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/blog_/$slug")({
  component: BlogDetailRoute,
  notFoundComponent: BlogNotFound,
});

function BlogDetailRoute() {
  const entry = Route.useLoaderData();

  return (
    <div className="space-y-8 lg:space-y-10">
      <header className="space-y-5 border-b border-border/70 pb-8">
        <Button asChild className="w-fit gap-2" variant="outline">
          <Link to="/blog">
            <RiArrowLeftLine aria-hidden="true" className="size-4" />
            Back to writing
          </Link>
        </Button>

        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <p className="site-label">Article</p>
            <p className="text-sm leading-7 text-muted-foreground">blog/{entry.slug}</p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiArticleLine aria-hidden="true" className="size-3.5" />
                Writing view
              </Badge>
              <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
            </div>

            <div className="space-y-3">
              <h1 className="max-w-5xl text-4xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-[3.6rem]">
                {entry.frontmatter.title}
              </h1>
              <p className="max-w-3xl text-base leading-8 text-foreground/88">
                {entry.frontmatter.description ?? entry.frontmatter.summary}
              </p>
            </div>
          </div>
        </div>

        <PublicMetadataStrip
          items={[
            { label: "Slug", value: entry.slug },
            { label: "Published", value: entry.frontmatter.publishedAt },
            {
              label: "Description",
              value: entry.frontmatter.description ? "Extended summary available" : "Summary-led entry",
            },
            { label: "Format", value: "Safe markdown" },
          ]}
        />
      </header>

      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <div className="site-panel px-5 py-4">
            <p className="site-label">Reading guide</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              The return path stays visible, metadata stays compact, and the body gets room to read
              without unnecessary decoration.
            </p>
          </div>

          <div className="site-panel px-5 py-4">
            <p className="site-label">Internal links</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              Markdown links that point back into the site continue to route through TanStack Router.
            </p>
          </div>
        </aside>

        <div className="site-panel px-5 py-5 lg:px-7 lg:py-7">
          <PublicReadingFrame title="Full article">
            <LazyPublicMarkdown
              markdown={entry.body}
              renderInternalLink={renderPublicMarkdownInternalLink}
            />
          </PublicReadingFrame>
        </div>
      </div>
    </div>
  );
}

function BlogNotFound() {
  return (
    <div className="site-panel max-w-3xl px-5 py-6 lg:px-8 lg:py-8">
      <div className="space-y-4">
        <Badge variant="destructive">Post unavailable</Badge>
        <div className="space-y-3">
          <h2 className="text-3xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That post is not part of the current archive.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
            Return to the writing page to review the posts that are currently published.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/blog">Browse writing</Link>
        </Button>
      </div>
    </div>
  );
}
