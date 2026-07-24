import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiArrowRightUpLine } from "@remixicon/react";

import {
  PublicProjectLedgerItem,
  PublicSectionHeading,
} from "@/features/public-site/components";
import { Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/projects")({
  component: ProjectsRoute,
});

function ProjectsRoute() {
  const projects = Route.useLoaderData();

  return (
    <div className="space-y-5">
      <PublicSectionHeading
        title="Projects"
      />

      <div className="grid gap-3">
        {projects.map((project, index) => {
          const { liveUrl, repoUrl } = project.frontmatter;
          const hasActions = Boolean(liveUrl) || Boolean(repoUrl);

          return (
            <PublicProjectLedgerItem
              actions={
                hasActions ? (
                  <>
                    {liveUrl ? (
                      <Button asChild className="w-fit gap-2">
                        <a href={liveUrl} rel="noreferrer" target="_blank">
                          Visit site
                          <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                        </a>
                      </Button>
                    ) : null}
                    {repoUrl ? (
                      <Button asChild className="w-fit gap-2" variant="secondary">
                        <a href={repoUrl} rel="noreferrer" target="_blank">
                          Open repository
                          <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                        </a>
                      </Button>
                    ) : null}
                  </>
                ) : undefined
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
          );
        })}
      </div>
    </div>
  );
}
