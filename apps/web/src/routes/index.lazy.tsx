import { Link, createLazyFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiArticleLine,
  RiFolderLine,
  RiUserLine,
} from "@remixicon/react";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  PublicContentParagraphs,
  PublicProjectLedgerItem,
  PublicReadingFrame,
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";
import { Badge, Button, Separator } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const { blogEntries, home, projects } = Route.useLoaderData();

  return (
    <div className="space-y-10 lg:space-y-12">
      <section className="border-b border-border/70 pb-10 lg:pb-12">
        <div className="space-y-7">
          <div className="space-y-3">
            <p className="site-label">About my work</p>
            <h1 className="max-w-4xl text-4xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground sm:text-5xl lg:text-[3.6rem]">
              {home.frontmatter.title}
            </h1>
            <p className="max-w-3xl text-base leading-8 text-foreground/88">
              {home.frontmatter.intro}
            </p>
          </div>

          <PublicContentParagraphs
            columns={2}
            paragraphs={[home.frontmatter.summary, home.frontmatter.mission]}
          />
        </div>
      </section>

      <section>
        <div className="grid gap-9 xl:grid-cols-2 xl:items-stretch">
          <div className="flex h-full flex-col gap-4">
            <PublicSectionHeading
              badges={
                <Badge className="gap-1.5">
                  <RiFolderLine aria-hidden="true" className="size-3.5" />
                  Featured projects
                </Badge>
              }
              description="A few current builds, summarized before you commit to the full write-up."
              title="Recent project work"
            />

            <div className="grid flex-1 gap-3">
              {projects.map((project, index) => (
                <PublicProjectLedgerItem
                  index={index + 1}
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
                />
              ))}
            </div>

            <Button asChild className="w-fit gap-2" variant="outline">
              <Link to="/projects">
                View all projects
                <RiArrowRightUpLine aria-hidden="true" className="size-4" />
              </Link>
            </Button>
          </div>

          <div className="flex h-full flex-col gap-4">
            <PublicSectionHeading
              badges={
                <Badge className="gap-1.5">
                  <RiArticleLine aria-hidden="true" className="size-3.5" />
                  Recent writing
                </Badge>
              }
              description="Posts stay chronological and compact so older writing is still easy to revisit."
              title="Latest notes and articles"
            />

            <div className="grid flex-1 gap-3">
              {blogEntries.map((entry, index) => (
                <PublicTransmissionListItem
                  entry={entry}
                  index={index + 1}
                  key={entry.slug}
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

            <Button asChild className="w-fit gap-2" variant="outline">
              <Link to="/blog">
                View all writing
                <RiArrowRightUpLine aria-hidden="true" className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      <section>
        <div className="space-y-5">
          <div className="site-panel px-5 py-5 lg:px-7 lg:py-7">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiUserLine aria-hidden="true" className="size-3.5" />
                Working principles
              </Badge>
              <Badge variant="outline">Markdown source</Badge>
            </div>

            <Separator className="my-5 border-border/60" />

            <PublicReadingFrame title="How I think about systems, collaboration, and maintainability.">
              <LazyPublicMarkdown
                markdown={home.body}
                renderInternalLink={renderPublicMarkdownInternalLink}
              />
            </PublicReadingFrame>
          </div>
        </div>
      </section>
    </div>
  );
}
