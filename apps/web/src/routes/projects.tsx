import { Link, createFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiLayoutGridLine } from "@remixicon/react";

import { projectEntries } from "@/features/content/site-content";
import {
  Badge,
  Button,
  Card,
  PublicProjectCard,
  PublicSectionHeading,
} from "@unimatrix/ui";

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
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                  Projects
                </Badge>
                <Badge variant="outline">public v1 selection</Badge>
              </>
            }
            description="Only the entries that support the lightweight public site are carried forward here; legacy docs routes and policy pages stay intentionally out of scope for now."
            title="Selected project write-ups now live under content/projects instead of the Hugo-era posts collection."
          />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
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
            actions={
              project.frontmatter.repoUrl ? (
                <Button asChild variant="secondary" className="w-fit gap-2">
                  <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                    View repository
                    <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                  </a>
                </Button>
              ) : null
            }
          />
        ))}
      </div>
    </div>
  );
}
