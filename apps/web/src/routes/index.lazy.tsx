import { Link, createLazyFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiBroadcastLine,
  RiLayoutGridLine,
  RiPulseLine,
  RiStackLine,
} from "@remixicon/react";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  PublicContentParagraphs,
  PublicPostListItem,
  PublicProjectCard,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { Badge, Button, Card, Separator } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const { blogEntries, home, projects } = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1.2fr)_22rem]">
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
              <Badge className="gap-1.5">
                <RiBroadcastLine aria-hidden="true" className="size-3.5" />
                Primary node
              </Badge>
              <Badge variant="outline">Backend-first systems</Badge>
              <Badge variant="secondary">Open-source and security minded</Badge>
            </div>

            <div className="space-y-4">
              <p className="borg-section-kicker">Collective signal</p>
              <h2 className="max-w-4xl text-4xl leading-[0.88] font-medium tracking-[-0.08em] text-foreground sm:text-5xl lg:text-6xl">
                {home.frontmatter.title}
              </h2>
              <p className="max-w-3xl text-base leading-8 text-foreground/88">
                {home.frontmatter.intro}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2">
                <Link to="/projects">
                  Inspect project nodes
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild className="gap-2" variant="outline">
                <Link to="/blog">
                  Read transmissions
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
              <Button asChild className="gap-2" variant="secondary">
                <Link to="/status">
                  Open diagnostics
                  <RiPulseLine aria-hidden="true" className="size-4" />
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 self-start">
            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Signal inventory</p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Featured projects</dt>
                  <dd>{projects.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Queued transmissions</dt>
                  <dd>{blogEntries.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Registry mode</dt>
                  <dd>manual</dd>
                </div>
              </dl>
            </div>

            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Design posture</p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                High-contrast structure, deliberate whitespace, and cold monospaced framing keep
                the interface readable under sustained attention.
              </p>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_24rem]">
        <div className="grid gap-6">
          <PublicContentParagraphs
            columns={2}
            paragraphs={[home.frontmatter.summary, home.frontmatter.mission]}
          />

          <Card className="borg-panel overflow-hidden">
            <div className="space-y-6 px-6 py-6">
              <PublicSectionHeading
                badges={
                  <>
                    <Badge className="gap-1.5">
                      <RiBroadcastLine aria-hidden="true" className="size-3.5" />
                      Operating doctrine
                    </Badge>
                    <Badge variant="outline">Repo-authored markdown</Badge>
                  </>
                }
                description="The body copy stays in markdown, but the surrounding frame treats it like a technical dossier rather than a blog dump."
                title="Systems worth shipping should explain themselves under inspection."
                trailing={<RiLayoutGridLine aria-hidden="true" className="size-4 text-primary" />}
              />

              <Separator className="border-primary/15" />

              <LazyPublicMarkdown
                markdown={home.body}
                renderInternalLink={renderPublicMarkdownInternalLink}
              />
            </div>
          </Card>
        </div>

        <aside className="grid gap-4 self-start xl:sticky xl:top-6">
          <Card className="borg-panel overflow-hidden" size="sm">
            <div className="space-y-4 px-4 py-4">
              <PublicSectionHeading
                badges={<Badge variant="secondary">Featured project nodes</Badge>}
                description="Current public build surfaces prepared for direct drill-down."
                trailing={<RiLayoutGridLine aria-hidden="true" className="size-4 text-primary" />}
              />

              <div className="grid gap-3">
                {projects.map((project) => (
                  <PublicProjectCard
                    key={project.slug}
                    project={project}
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
                    variant="compact"
                  />
                ))}
              </div>
            </div>
          </Card>

          <Card className="borg-panel overflow-hidden" size="sm">
            <div className="space-y-4 px-4 py-4">
              <PublicSectionHeading
                badges={<Badge variant="secondary">Latest transmissions</Badge>}
                description="Field notes and written diagnostics queued inside the same node."
                trailing={<RiStackLine aria-hidden="true" className="size-4 text-primary" />}
              />

              <div className="grid gap-3">
                {blogEntries.map((entry) => (
                  <PublicPostListItem
                    key={entry.slug}
                    entry={entry}
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
                    variant="compact"
                  />
                ))}
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
