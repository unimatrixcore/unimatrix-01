import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiFolderLine } from "@remixicon/react";

import {
  PublicProjectLedgerItem,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { Badge, Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/projects")({
  component: ProjectsRoute,
});

function ProjectsRoute() {
  const projects = Route.useLoaderData();
  const featuredProjects = projects.filter((project) => project.frontmatter.featured).length;
  const repositoryLinkedProjects = projects.filter((project) => project.frontmatter.repoUrl).length;

  return (
    <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-9">
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <div className="space-y-3">
          <p className="site-label">Projects</p>
          <p className="text-sm leading-7 text-muted-foreground">
            Built to compare quickly: status first, then summary, then the deeper project page.
          </p>
        </div>

        <div className="site-panel px-5 py-4">
          <p className="site-label">How to browse</p>
          <p className="mt-3 text-sm leading-7 text-foreground/88">
            Start with the summary, check current status, and open the full page only when you want
            implementation detail.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="site-panel px-5 py-4">
            <p className="site-label">Total projects</p>
            <p className="mt-3 text-2xl leading-none font-medium tracking-[-0.06em] text-foreground">
              {projects.length}
            </p>
          </div>
          <div className="site-panel px-5 py-4">
            <p className="site-label">Featured</p>
            <p className="mt-3 text-2xl leading-none font-medium tracking-[-0.06em] text-foreground">
              {featuredProjects}
            </p>
          </div>
          <div className="site-panel px-5 py-4">
            <p className="site-label">Repositories linked</p>
            <p className="mt-3 text-2xl leading-none font-medium tracking-[-0.06em] text-foreground">
              {repositoryLinkedProjects}
            </p>
          </div>
        </div>
      </aside>

      <section className="grid gap-4">
        <PublicSectionHeading
          badges={
            <>
              <Badge className="gap-1.5">
                <RiFolderLine aria-hidden="true" className="size-3.5" />
                Project list
              </Badge>
              <Badge variant="outline">Direct comparison</Badge>
            </>
          }
          description="A compact list of current work, with enough context to decide where to dive deeper."
          title="Selected builds and experiments"
        />

        <div className="grid gap-3">
          {projects.map((project, index) => (
            <PublicProjectLedgerItem
              actions={
                project.frontmatter.repoUrl ? (
                  <Button asChild className="w-fit gap-2" variant="secondary">
                    <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                      Open repository
                      <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                    </a>
                  </Button>
                ) : null
              }
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
      </section>
    </div>
  );
}
