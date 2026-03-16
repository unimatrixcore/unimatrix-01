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
import {
  Badge,
  Button,
  Card,
  PublicContentParagraphs,
  PublicPostListItem,
  PublicProjectCard,
  PublicSectionHeading,
  Separator,
} from "@unimatrix/ui";

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
            <PublicSectionHeading
              badges={
                <>
                  <Badge className="gap-1.5">
                    <RiCompassDiscoverLine aria-hidden="true" className="size-3.5" />
                    Home content
                  </Badge>
                  <Badge variant="outline">repo-backed</Badge>
                </>
              }
              description={home.frontmatter.summary}
              descriptionClassName="max-w-2xl"
              title={home.frontmatter.title}
              titleClassName="lg:text-3xl"
            />

            <Separator />

            <PublicContentParagraphs columns={2} paragraphs={homeParagraphs} />

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
            <PublicSectionHeading
              badges={<Badge variant="secondary">Mission</Badge>}
              description={home.frontmatter.mission}
              trailing={<RiLayoutGridLine aria-hidden="true" className="size-4 text-muted-foreground" />}
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-4">
        <Card size="sm" className="border-border/60 bg-card/82 shadow-none backdrop-blur">
          <div className="space-y-4 px-4">
            <PublicSectionHeading
              badges={<Badge variant="secondary">Featured projects</Badge>}
              trailing={<RiLayoutGridLine aria-hidden="true" className="size-4 text-muted-foreground" />}
            />
            <div className="grid gap-3">
              {projects.map((project) => (
                <PublicProjectCard
                  key={project.slug}
                  project={project}
                  variant="compact"
                  renderLink={({ ariaLabel, children, className }) => (
                    <Link
                      aria-label={ariaLabel}
                      className={className}
                      params={{ slug: project.slug }}
                      to="/projects/$slug"
                    >
                      {children}
                    </Link>
                  )}
                />
              ))}
            </div>
          </div>
        </Card>

        <Card size="sm" className="border-border/60 bg-card/82 shadow-none backdrop-blur">
          <div className="space-y-4 px-4">
            <PublicSectionHeading
              badges={<Badge variant="secondary">Recent blog posts</Badge>}
              trailing={<RiStackLine aria-hidden="true" className="size-4 text-muted-foreground" />}
            />
            <div className="grid gap-3">
              {blogEntries.map((entry) => (
                <PublicPostListItem
                  key={entry.slug}
                  entry={entry}
                  variant="compact"
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
        </Card>
      </div>
    </div>
  );
}
