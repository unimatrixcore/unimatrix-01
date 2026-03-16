import { Link, createFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiLayoutGridLine,
  RiCompassDiscoverLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { splitMarkdownIntoParagraphs } from "@/features/content/markdown";
import { featuredProjects, latestBlogEntries, homeContent } from "@/features/content/site-content";
import { Badge, Button, Card, Separator } from "@unimatrix/ui";

export const Route = createFileRoute("/")({
  component: IndexRoute,
  loader: () => ({
    blogEntries: latestBlogEntries,
    home: homeContent,
    projects: featuredProjects,
  }),
});

function IndexRoute() {
  const { blogEntries, home, projects } = Route.useLoaderData();
  const homeParagraphs = splitMarkdownIntoParagraphs(home.body);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(20rem,0.95fr)]">
      <div className="grid gap-6">
        <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
          <div className="space-y-6 px-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiCompassDiscoverLine aria-hidden="true" className="size-3.5" />
                Home content
              </Badge>
              <Badge variant="outline">repo-backed</Badge>
            </div>

            <div className="space-y-3">
              <h2 className="text-2xl leading-tight font-medium tracking-tight lg:text-3xl">
                {home.frontmatter.title}
              </h2>
              <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
                {home.frontmatter.summary}
              </p>
            </div>

            <Separator />

            <div className="grid gap-4 lg:grid-cols-2">
              {homeParagraphs.map((paragraph, index) => (
                <p key={`${index}:${paragraph}`} className="text-sm leading-7 text-muted-foreground lg:text-base">
                  {paragraph}
                </p>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2">
                <Link to="/projects">
                  Browse projects
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="outline" className="gap-2">
                <Link to="/blog">
                  Read the blog
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild variant="secondary" className="gap-2">
                <Link to="/status">
                  Check API status
                  <RiPulseLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </Card>

        <Card className="border-border/60 bg-card/90 shadow-none">
          <div className="space-y-4 px-6">
            <div className="flex items-center justify-between gap-3">
              <Badge variant="secondary">Mission</Badge>
              <RiLayoutGridLine aria-hidden="true" className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm leading-7 text-muted-foreground lg:text-base">
              {home.frontmatter.mission}
            </p>
          </div>
        </Card>
      </div>

      <div className="grid gap-4">
        <Card size="sm" className="border-border/60 bg-card/82 shadow-none backdrop-blur">
          <div className="space-y-4 px-4">
            <div className="flex items-center justify-between gap-3">
              <Badge variant="secondary">Featured projects</Badge>
              <RiLayoutGridLine aria-hidden="true" className="size-4 text-muted-foreground" />
            </div>
            <div className="grid gap-3">
              {projects.map((project) => (
                <div key={project.slug} className="space-y-2 border border-border/60 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{project.frontmatter.status}</Badge>
                    <Badge variant="outline">{project.frontmatter.publishedAt}</Badge>
                  </div>
                  <h3 className="text-sm leading-6 font-medium">{project.frontmatter.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {project.frontmatter.summary}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card size="sm" className="border-border/60 bg-card/82 shadow-none backdrop-blur">
          <div className="space-y-4 px-4">
            <div className="flex items-center justify-between gap-3">
              <Badge variant="secondary">Recent blog posts</Badge>
              <RiStackLine aria-hidden="true" className="size-4 text-muted-foreground" />
            </div>
            <div className="grid gap-3">
              {blogEntries.map((entry) => (
                <div key={entry.slug} className="space-y-2 border border-border/60 px-3 py-3">
                  <Badge variant="outline">{entry.frontmatter.publishedAt}</Badge>
                  <h3 className="text-sm leading-6 font-medium">{entry.frontmatter.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {entry.frontmatter.summary}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
