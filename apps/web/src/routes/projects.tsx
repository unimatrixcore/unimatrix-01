import { createFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiLayoutGridLine } from "@remixicon/react";

import { projectEntries } from "@/features/content/site-content";
import { Badge, Button, Card } from "@unimatrix/ui";

export const Route = createFileRoute("/projects")({
  component: ProjectsRoute,
  loader: () => projectEntries,
});

function ProjectsRoute() {
  const projects = Route.useLoaderData();

  return (
    <div className="grid gap-6">
      <Card className="border-border/60 bg-card/94 shadow-[0_18px_60px_-36px_color-mix(in_oklab,var(--foreground)_22%,transparent)]">
        <div className="space-y-4 px-6">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5">
              <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
              Projects
            </Badge>
            <Badge variant="outline">legacy posts translated</Badge>
          </div>
          <div className="space-y-3">
            <h2 className="text-2xl leading-tight font-medium tracking-tight">
              Project content now lives under content/projects instead of the Hugo-era posts naming.
            </h2>
            <p className="max-w-3xl text-sm leading-7 text-muted-foreground lg:text-base">
              The route only needs a typed listing for this issue, but the shared collection is now ready for later detail pages.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {projects.map((project) => (
          <Card key={project.slug} className="border-border/60 bg-card/88 shadow-none">
            <div className="space-y-4 px-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge>{project.frontmatter.status}</Badge>
                <Badge variant="outline">{project.frontmatter.publishedAt}</Badge>
                <Badge variant="secondary">{project.filePath}</Badge>
              </div>
              <div className="space-y-2">
                <h3 className="text-xl leading-tight font-medium tracking-tight">
                  {project.frontmatter.title}
                </h3>
                <p className="text-sm leading-7 text-muted-foreground">
                  {project.frontmatter.summary}
                </p>
                <p className="text-sm leading-7 text-muted-foreground">{project.excerpt}</p>
              </div>
              {project.frontmatter.repoUrl ? (
                <Button asChild variant="outline" className="w-fit gap-2">
                  <a
                    href={project.frontmatter.repoUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    View repository
                    <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                  </a>
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}