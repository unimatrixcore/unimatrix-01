import { RiArrowLeftLine, RiArrowRightUpLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import { ProjectStatusBadge } from "@/features/public-site/components";
import { Badge, Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/projects_/$slug")({
  component: ProjectDetailRoute,
  notFoundComponent: ProjectNotFound,
});

function ProjectDetailRoute() {
  const project = Route.useLoaderData();

  return (
    <div className="space-y-8 lg:space-y-10">
      <header className="space-y-5 border-b border-border/70 pb-8">
        <Button asChild className="w-fit gap-2" variant="outline">
          <Link to="/projects">
            <RiArrowLeftLine aria-hidden="true" className="size-4" />
            Back to projects
          </Link>
        </Button>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectStatusBadge frontmatter={project.frontmatter} />
            <Badge variant="secondary">{project.frontmatter.publishedAt}</Badge>
          </div>

          <h1 className="max-w-4xl text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
            {project.frontmatter.title}
          </h1>
          <p className="max-w-2xl text-[0.95rem] leading-7 text-foreground/86">
            {project.frontmatter.summary}
          </p>

          <div className="flex flex-wrap gap-3">
            {project.frontmatter.liveUrl ? (
              <Button asChild className="w-fit gap-2">
                <a href={project.frontmatter.liveUrl} rel="noreferrer" target="_blank">
                  Visit site
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            ) : null}
            {project.frontmatter.repoUrl ? (
              <Button asChild className="w-fit gap-2" variant="secondary">
                <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                  Open repository
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="site-panel mx-auto max-w-4xl px-5 py-5 lg:px-8 lg:py-8">
        <article className="public-markdown">
          <LazyPublicMarkdown
            markdown={project.body}
            renderInternalLink={renderPublicMarkdownInternalLink}
          />
        </article>
      </div>
    </div>
  );
}

function ProjectNotFound() {
  return (
    <div className="site-panel max-w-3xl px-5 py-6 lg:px-8 lg:py-8">
      <div className="space-y-4">
        <Badge variant="destructive">Project unavailable</Badge>
        <div className="space-y-3">
          <h2 className="text-3xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That project is not part of the current list.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
            Return to the projects page to review the work that is currently published.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/projects">Browse projects</Link>
        </Button>
      </div>
    </div>
  );
}
