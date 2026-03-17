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
  const activeProjects = projects.filter((project) => project.frontmatter.status === "in-progress").length;
  const repositoryLinkedProjects = projects.filter((project) => project.frontmatter.repoUrl).length;

  return (
    <div className="grid gap-6">
      <Card className="border border-border/70 bg-background/56 shadow-[0_32px_120px_-76px_color-mix(in_oklab,var(--foreground)_72%,transparent)] backdrop-blur-xl">
        <div className="grid gap-8 px-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <PublicSectionHeading
            badges={
              <>
                <Badge className="gap-1.5">
                  <RiLayoutGridLine aria-hidden="true" className="size-3.5" />
                  Projects archive
                </Badge>
                <Badge variant="outline">public route index</Badge>
              </>
            }
            description="This route behaves like a compact dossier index: typed repo-backed entries stay visible, linkable, and easy to audit without reviving the Hugo-era content model."
            title="Current project write-ups are organized as a console archive instead of loose cards."
          />

          <div className="grid gap-3 self-start">
            <div className="border border-border/70 bg-background/40 px-4 py-4">
              <p className="text-[0.7rem] uppercase tracking-[0.28em] text-muted-foreground">
                Archive counts
              </p>
              <dl className="mt-4 grid gap-3 text-sm text-foreground/88">
                <div className="flex items-center justify-between gap-3">
                  <dt>Total entries</dt>
                  <dd>{projects.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>In progress</dt>
                  <dd>{activeProjects}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt>Repo links</dt>
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
