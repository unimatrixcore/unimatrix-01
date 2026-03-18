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

  return (
    <div className="space-y-5">
      <PublicSectionHeading
        badges={
          <Badge className="gap-1.5">
            <RiFolderLine aria-hidden="true" className="size-3.5" />
            Projects
          </Badge>
        }
        description="Selected builds and experiments, with enough context to decide where to dive deeper."
        title="Project work"
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
    </div>
  );
}
