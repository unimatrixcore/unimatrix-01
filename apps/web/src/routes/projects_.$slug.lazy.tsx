import {
  RiArrowLeftLine,
  RiArrowRightUpLine,
  RiLayoutGridLine,
} from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import { Badge, Button, Card, Separator } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/projects_/$slug")({
  component: ProjectDetailRoute,
  notFoundComponent: ProjectNotFound,
});

function ProjectDetailRoute() {
  const project = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
          <article className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                Project node
              </Badge>
              <Badge variant="outline">{project.frontmatter.publishedAt}</Badge>
              <Badge variant="secondary">{project.frontmatter.status}</Badge>
            </div>

            <div className="space-y-3">
              <p className="borg-data-label">Designation / projects/{project.slug}</p>
              <h2 className="max-w-4xl text-3xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-5xl">
                {project.frontmatter.title}
              </h2>
              <p className="max-w-3xl text-sm leading-7 text-foreground/88 lg:text-base lg:leading-8">
                {project.frontmatter.summary}
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button asChild className="gap-2" variant="outline">
                <Link to="/projects">
                  <RiArrowLeftLine aria-hidden="true" className="size-4" />
                  Back to project index
                </Link>
              </Button>
              {project.frontmatter.repoUrl ? (
                <Button asChild className="gap-2">
                  <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                    Open repository
                    <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                  </a>
                </Button>
              ) : null}
            </div>
          </article>

          <aside className="grid gap-3 self-start xl:sticky xl:top-6">
            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Node metadata</p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Slug</dt>
                  <dd>{project.slug}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Published</dt>
                  <dd>{project.frontmatter.publishedAt}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Status</dt>
                  <dd>{project.frontmatter.status}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Repository</dt>
                  <dd>{project.frontmatter.repoUrl ? "linked" : "pending"}</dd>
                </div>
              </dl>
            </div>

            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Rendering mode</p>
              <p className="mt-3 text-sm leading-7 text-foreground/88">
                Markdown flows through the public-safe pipeline with internal links handed back to
                the router.
              </p>
            </div>
          </aside>
        </div>
      </Card>

      <Card className="borg-panel overflow-hidden">
        <div className="space-y-6 px-6 py-6">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-2">
              <p className="borg-data-label">Integrated dossier</p>
              <h3 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
                Full project record
              </h3>
            </div>
            <RiLayoutGridLine aria-hidden="true" className="size-4 text-primary" />
          </div>

          <Separator className="border-primary/15" />

          <LazyPublicMarkdown
            markdown={project.body}
            renderInternalLink={renderPublicMarkdownInternalLink}
          />
        </div>
      </Card>
    </div>
  );
}

function ProjectNotFound() {
  return (
    <Card className="borg-panel overflow-hidden">
      <div className="space-y-4 px-6 py-6">
        <Badge variant="destructive">Node unavailable</Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
            That project designation is not part of the current lattice.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base lg:leading-8">
            Return to the project index to review the nodes that are currently online.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/projects">Browse project nodes</Link>
        </Button>
      </div>
    </Card>
  );
}
