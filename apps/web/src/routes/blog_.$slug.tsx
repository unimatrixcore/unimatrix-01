import { RiArrowLeftLine, RiStackLine } from "@remixicon/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { splitMarkdownIntoParagraphs } from "@/features/content/markdown";
import { getBlogEntryBySlug } from "@/features/content/site-content";
import { Badge, Button, Card, Separator } from "@unimatrix/ui";

export const Route = createFileRoute("/blog_/$slug")({
  component: BlogDetailRoute,
  loader: ({ params }) => {
    const entry = getBlogEntryBySlug(params.slug);

    if (!entry) {
      throw createBlogNotFoundError(params.slug);
    }

    return entry;
  },
  notFoundComponent: BlogNotFound,
});

function createBlogNotFoundError(slug: string): Error {
  return Object.assign(new Error(`Blog entry not found: ${slug}`), notFound());
}

function BlogDetailRoute() {
  const entry = Route.useLoaderData();
  const paragraphs = splitMarkdownIntoParagraphs(entry.body);

  return (
    <div className="grid gap-6">
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-6 px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5">
              <RiStackLine aria-hidden="true" className="size-3.5" />
              Blog detail
            </Badge>
            <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
          </div>

          <div className="space-y-3">
            <h2 className="text-2xl leading-tight font-medium tracking-tight lg:text-4xl">
              {entry.frontmatter.title}
            </h2>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
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

          <div className="grid gap-4 lg:max-w-4xl">
            {paragraphs.map((paragraph, index) => (
              <p key={index} className="text-sm leading-7 text-muted-foreground lg:text-base">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

function BlogNotFound() {
  return (
    <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
      <div className="space-y-4 px-6">
        <Badge variant="destructive">Blog entry not found</Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-tight">
            That blog entry slug is not part of the current public site.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
            Return to the blog index to browse the published notes and architecture writing.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/blog">Browse the blog</Link>
        </Button>
      </div>
    </Card>
  );
}
