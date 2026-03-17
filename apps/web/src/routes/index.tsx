import { Link, createFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiCompassDiscoverLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  PublicPostListItem,
  PublicProjectCard,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { featuredProjects, latestBlogEntries, homeContent } from "@/features/content/site-content";
import {
  Badge,
  Button,
  Card,
  PublicMarkdown,
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

  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.35fr)_24rem]">
      <div className="grid gap-6">
        <Card className="border border-border/70 bg-background/58 shadow-[0_32px_120px_-76px_color-mix(in_oklab,var(--foreground)_72%,transparent)] backdrop-blur-xl">
          <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="space-y-6">
              <PublicSectionHeading
                badges={
                  <>
                    <Badge className="gap-1.5">
                      <RiCompassDiscoverLine aria-hidden="true" className="size-3.5" />
                      System brief
                    </Badge>
                    <Badge variant="outline">homepage route</Badge>
                  </>
                }
                description={home.frontmatter.intro}
                title={home.frontmatter.title}
                titleClassName="max-w-4xl text-4xl lg:text-5xl"
              />

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="border border-border/60 bg-background/35 px-4 py-4">
                  <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                    Console summary
                  </p>
                  <p className="mt-3 text-sm leading-7 text-foreground/90">
                    {home.frontmatter.summary}
                  </p>
                </div>
                <div className="border border-border/60 bg-background/35 px-4 py-4">
                  <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                    Operating stance
                  </p>
                  <p className="mt-3 text-sm leading-7 text-foreground/90">
                    {home.frontmatter.mission}
                  </p>
                </div>
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
                    Open status route
                    <RiPulseLine aria-hidden="true" className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>

            <div className="grid gap-3 self-start">
              <div className="border border-border/70 bg-background/40 px-4 py-4">
                <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                  Route inventory
                </p>
                <dl className="mt-4 grid gap-3 text-sm text-foreground/90">
                  <div className="flex items-center justify-between gap-3">
                    <dt>Featured projects</dt>
                    <dd>{projects.length}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt>Latest notes</dt>
                    <dd>{blogEntries.length}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt>Registry mode</dt>
                    <dd>manual imports</dd>
                  </div>
                </dl>
              </div>
              <div className="border border-border/70 bg-background/40 px-4 py-4">
                <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                  Renderer signal
                </p>
                <p className="mt-3 text-sm leading-7 text-foreground/88">
                  Tables, task lists, images, blockquotes, and highlighted code blocks are now
                  enabled on authored content without raw HTML execution.
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card className="border border-border/70 bg-background/52 shadow-[0_30px_110px_-74px_color-mix(in_oklab,var(--foreground)_66%,transparent)] backdrop-blur-xl">
          <div className="space-y-6 px-6">
            <PublicSectionHeading
              badges={
                <>
                  <Badge variant="secondary">Mission / operating model</Badge>
                  <Badge variant="outline">rendered markdown</Badge>
                </>
              }
              description={home.frontmatter.summary}
              title="How the site is being run"
              trailing={<RiLayoutGridLine aria-hidden="true" className="size-4 text-muted-foreground" />}
            />

            <Separator />

            <PublicMarkdown
              markdown={home.body}
              renderInternalLink={renderPublicMarkdownInternalLink}
            />
          </div>
        </Card>
      </div>

      <div className="grid gap-4">
        <Card size="sm" className="border border-border/70 bg-background/46 shadow-none backdrop-blur-xl">
          <div className="space-y-4 px-4">
            <PublicSectionHeading
              badges={<Badge variant="secondary">Featured projects</Badge>}
              description="Active build targets and platform write-ups currently surfaced on the public route."
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

        <Card size="sm" className="border border-border/70 bg-background/46 shadow-none backdrop-blur-xl">
          <div className="space-y-4 px-4">
            <PublicSectionHeading
              badges={<Badge variant="secondary">Recent blog posts</Badge>}
              description="Latest architecture notes and content-system updates from the repo-backed collection."
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

        <Card size="sm" className="border border-border/70 bg-background/46 shadow-none backdrop-blur-xl">
          <div className="space-y-4 px-4">
            <PublicSectionHeading
              badges={<Badge variant="secondary">Status snapshot</Badge>}
              description="The live health check stays on its own route, but the shell keeps the signal visible here."
              trailing={<RiPulseLine aria-hidden="true" className="size-4 text-muted-foreground" />}
            />

            <div className="grid gap-3 text-sm text-foreground/88">
              <div className="border border-border/60 bg-background/35 px-3 py-3">
                <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                  Content
                </p>
                <p className="mt-2 leading-7">Repo-backed, typed, and manually registered.</p>
              </div>
              <div className="border border-border/60 bg-background/35 px-3 py-3">
                <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                  Rendering
                </p>
                <p className="mt-2 leading-7">Safe GFM only. Raw HTML and executable MDX stay off.</p>
              </div>
            </div>

            <Button asChild variant="outline" className="w-full gap-2">
              <Link to="/status">
                Inspect the status route
                <RiArrowRightUpLine aria-hidden="true" className="size-4" />
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
