import { Link, createLazyFileRoute } from "@tanstack/react-router";
import {
  RiArrowRightUpLine,
  RiArticleLine,
  RiFolderLine,
} from "@remixicon/react";

import {
  PublicProjectLedgerItem,
  PublicSectionHeading,
  PublicTransmissionListItem,
} from "@/features/public-site/components";
import { Badge, Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  const { blogEntries, home, projects } = Route.useLoaderData();

  return (
    <div className="space-y-12 lg:space-y-16">
      <section className="max-w-3xl space-y-4 pb-2">
        <h1 className="text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
          {home.frontmatter.title}
        </h1>
        <p className="max-w-2xl text-[0.95rem] leading-7 text-foreground/86">
          {home.frontmatter.intro}
        </p>
      </section>

      <div className="grid gap-8 xl:grid-cols-2 xl:items-stretch">
        <section className="flex h-full flex-col gap-5">
          <PublicSectionHeading
          badges={
            <Badge className="gap-1.5">
              <RiFolderLine aria-hidden="true" className="size-3.5" />
              Featured projects
            </Badge>
          }
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
        </section>

        <section className="flex h-full flex-col gap-5">
          <PublicSectionHeading
          badges={
            <Badge className="gap-1.5">
              <RiArticleLine aria-hidden="true" className="size-3.5" />
              Recent blog posts
            </Badge>
          }
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
              View all blog posts
              <RiArrowRightUpLine aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        </section>
      </div>
    </div>
  );
}
