import { RiArrowLeftLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
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
            Back to blog
          </Link>
        </Button>

        <div className="space-y-4">
          <Badge variant="secondary">{entry.frontmatter.publishedAt}</Badge>

          <h1 className="max-w-4xl text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
            {entry.frontmatter.title}
          </h1>
          <p className="max-w-2xl text-[0.95rem] leading-7 text-foreground/86">
            {entry.frontmatter.description ?? entry.frontmatter.summary}
          </p>
        </div>
      </header>

      <div className="site-panel mx-auto max-w-4xl px-5 py-5 lg:px-8 lg:py-8">
        <article className="public-markdown">
          <LazyPublicMarkdown
            markdown={entry.body}
            renderInternalLink={renderPublicMarkdownInternalLink}
          />
        </article>
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
            Return to the blog page to review the posts that are currently published.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/blog">Browse blog</Link>
        </Button>
      </div>
    </div>
  );
}
