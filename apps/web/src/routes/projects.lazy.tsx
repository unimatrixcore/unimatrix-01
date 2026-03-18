import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine, RiLayoutGridLine } from "@remixicon/react";

import {
  PublicProjectCard,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { Badge, Button, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/projects")({
  component: ProjectsRoute,
});

function ProjectsRoute() {
  const projects = Route.useLoaderData();
  const featuredProjects = projects.filter((project) => project.frontmatter.featured).length;
  const repositoryLinkedProjects = projects.filter((project) => project.frontmatter.repoUrl).length;

  return (
    <div className="grid gap-6">
      <Card className="borg-panel borg-grid-surface overflow-hidden border-primary/20 bg-background/82">
        <div className="grid gap-8 px-6 py-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                  Project lattice
                </Badge>
                <Badge variant="outline">Repo-backed index</Badge>
              </>
            }
            description="Each project entry is a deliberate node in the public lattice: typed frontmatter, explicit registration, and a detail page ready for inspection."
            title="Project surfaces stay sparse until a system can explain itself clearly."
          />

          <div className="grid gap-3 self-start">
            <div className="borg-subpanel px-4 py-4">
              <p className="borg-data-label">Lattice counts</p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Total nodes</dt>
                  <dd>{projects.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Featured</dt>
                  <dd>{featuredProjects}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>External repos</dt>
                  <dd>{repositoryLinkedProjects}</dd>
                </div>
              </dl>
            </div>
          </div>
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
                <Button asChild className="w-fit gap-2" variant="secondary">
                  <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                    Open repository
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
