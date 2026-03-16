import { RiArrowLeftLine, RiArrowRightUpLine, RiLayoutGridLine } from "@remixicon/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { splitMarkdownIntoParagraphs } from "@/features/content/markdown";
import { getProjectEntryBySlug } from "@/features/content/site-content";
import { Badge, Button, Card, Separator } from "@unimatrix/ui";

export const Route = createFileRoute("/projects/$slug")({
  component: ProjectDetailRoute,
  loader: ({ params }) => {
    const project = getProjectEntryBySlug(params.slug);

    if (!project) {
      throw notFound() as Error;
    }

    return project;
  },
  notFoundComponent: ProjectNotFound,
});

function ProjectDetailRoute() {
  const project = Route.useLoaderData();
  const paragraphs = splitMarkdownIntoParagraphs(project.body);

  return (
    <div className="grid gap-6">
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-6 px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5">
              <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
              Project detail
            </Badge>
            <Badge variant="outline">{project.frontmatter.publishedAt}</Badge>
            <Badge variant="secondary">{project.frontmatter.status}</Badge>
          </div>

          <div className="space-y-3">
            <h2 className="text-2xl leading-tight font-medium tracking-tight lg:text-4xl">
              {project.frontmatter.title}
            </h2>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
              {project.frontmatter.summary}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button asChild variant="outline" className="gap-2">
              <Link to="/projects">
                <RiArrowLeftLine aria-hidden="true" className="size-4" />
                Back to projects
              </Link>
            </Button>
            {project.frontmatter.repoUrl ? (
              <Button asChild className="gap-2">
                <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                  View repository
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            ) : null}
          </div>

          <Separator />

          <div className="grid gap-4 lg:max-w-4xl">
            {paragraphs.map((paragraph, index) => (
              <p key={`${index}:${paragraph}`} className="text-sm leading-7 text-muted-foreground lg:text-base">
                {paragraph}
              </p>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProjectNotFound() {
  return (
    <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
      <div className="space-y-4 px-6">
        <Badge variant="destructive">Project not found</Badge>
        <div className="space-y-3">
          <h2 className="text-2xl leading-tight font-medium tracking-tight">
            That project slug is not part of the current public site.
          </h2>
          <p className="max-w-2xl text-sm leading-7 text-muted-foreground lg:text-base">
            Return to the projects index to browse the authored write-ups that are currently published.
          </p>
        </div>
        <Button asChild className="w-fit">
          <Link to="/projects">Browse projects</Link>
        </Button>
      </div>
    </Card>
  );
}