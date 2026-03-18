import { RiArrowLeftLine, RiArrowRightUpLine, RiFolderLine } from "@remixicon/react";
import { Link, createLazyFileRoute } from "@tanstack/react-router";

import { LazyPublicMarkdown } from "@/features/content/lazy-public-markdown";
import { renderPublicMarkdownInternalLink } from "@/features/content/markdown";
import {
  PublicMetadataStrip,
  PublicReadingFrame,
} from "@/features/public-site/components";
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

        <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <div className="space-y-3">
            <p className="site-label">Project page</p>
            <p className="text-sm leading-7 text-muted-foreground">projects/{project.slug}</p>
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="gap-1.5">
                <RiFolderLine aria-hidden="true" className="size-3.5" />
                Project details
              </Badge>
              <Badge variant="outline">{project.frontmatter.status}</Badge>
              <Badge variant="secondary">{project.frontmatter.publishedAt}</Badge>
            </div>

            <div className="space-y-3">
              <h1 className="max-w-5xl text-4xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-[3.6rem]">
                {project.frontmatter.title}
              </h1>
              <p className="max-w-3xl text-base leading-8 text-foreground/88">
                {project.frontmatter.summary}
              </p>
            </div>

            {project.frontmatter.repoUrl ? (
              <Button asChild className="w-fit gap-2">
                <a href={project.frontmatter.repoUrl} rel="noreferrer" target="_blank">
                  Open repository
                  <RiArrowRightUpLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>

        <PublicMetadataStrip
          items={[
            { label: "Slug", value: project.slug },
            { label: "Published", value: project.frontmatter.publishedAt },
            { label: "Status", value: project.frontmatter.status },
            {
              label: "Repository",
              value: project.frontmatter.repoUrl ? "Available" : "Not public yet",
            },
          ]}
        />
      </header>

      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <div className="site-panel px-5 py-4">
            <p className="site-label">Reading guide</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              Context comes first, key metadata stays visible, and the main body reads like a proper
              project write-up instead of a stacked marketing page.
            </p>
          </div>

          <div className="site-panel px-5 py-4">
            <p className="site-label">Markdown pipeline</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              Safe markdown with router-aware internal links. No raw HTML execution path.
            </p>
          </div>
        </aside>

        <div className="site-panel px-5 py-5 lg:px-7 lg:py-7">
          <PublicReadingFrame title="Full project write-up">
            <LazyPublicMarkdown
              markdown={project.body}
              renderInternalLink={renderPublicMarkdownInternalLink}
            />
          </PublicReadingFrame>
        </div>
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
