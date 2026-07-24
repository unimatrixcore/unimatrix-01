import { createLazyFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  RiGithubLine,
  RiMailLine,
  RiSendPlaneLine,
} from "@remixicon/react";

import { homeContent } from "@/features/content/site-content";
import {
  emailAddress,
  githubProfileUrl,
  projectRepoUrl,
} from "@/features/public-site/site-links";
import { Button } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/about")({
  component: AboutRoute,
});

function AboutRoute() {
  const [formState, setFormState] = useState({ email: "", message: "", name: "" });

  const mailtoHref = useMemo(() => {
    const subject = formState.name
      ? `Portfolio inquiry from ${formState.name}`
      : "Portfolio inquiry";
    const lines = [
      formState.name ? `Name: ${formState.name}` : null,
      formState.email ? `Email: ${formState.email}` : null,
      formState.message || "I'd like to get in touch about your work.",
    ].filter((line): line is string => line !== null);

    return `mailto:${emailAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n\n"))}`;
  }, [formState.email, formState.message, formState.name]);

  return (
    <div className="space-y-10 lg:space-y-12">
      <header className="max-w-3xl space-y-4 border-b border-border/70 pb-8">
        <h1 className="text-3xl leading-[0.92] font-medium tracking-[-0.06em] text-foreground sm:text-4xl lg:text-[3.2rem]">
          About
        </h1>
        <p className="text-[0.95rem] leading-7 text-foreground/86">
          {homeContent.frontmatter.intro}
        </p>
      </header>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]">
        <section className="site-panel px-5 py-5 lg:px-7 lg:py-7">
          <div className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-2xl">
                Reach out directly
              </h2>
              <p className="max-w-2xl text-sm leading-7 text-muted-foreground">
                If you want to talk about a project, collaboration, or a technical problem worth
                solving, email is the fastest route.
              </p>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <a
                className="site-atlas-link border border-border/70 bg-background/72 px-4 py-4 transition-colors hover:border-primary/40 hover:bg-secondary/26"
                href={`mailto:${emailAddress}`}
              >
                <div className="flex items-center gap-2 text-foreground">
                  <RiMailLine aria-hidden="true" className="size-4 text-primary" />
                  <span className="text-sm font-medium">Email</span>
                </div>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">{emailAddress}</p>
              </a>

              <a
                className="site-atlas-link border border-border/70 bg-background/72 px-4 py-4 transition-colors hover:border-primary/40 hover:bg-secondary/26"
                href={githubProfileUrl}
                rel="noreferrer"
                target="_blank"
              >
                <div className="flex items-center gap-2 text-foreground">
                  <RiGithubLine aria-hidden="true" className="size-4 text-primary" />
                  <span className="text-sm font-medium">GitHub</span>
                </div>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">github.com/gwenphalan</p>
              </a>

              <a
                className="site-atlas-link border border-border/70 bg-background/72 px-4 py-4 transition-colors hover:border-primary/40 hover:bg-secondary/26 md:col-span-2"
                href={projectRepoUrl}
                rel="noreferrer"
                target="_blank"
              >
                <div className="flex items-center gap-2 text-foreground">
                  <RiGithubLine aria-hidden="true" className="size-4 text-primary" />
                  <span className="text-sm font-medium">This site&apos;s repository</span>
                </div>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">
                  View the repo that powers this portfolio and its content pipeline.
                </p>
              </a>
            </div>
          </div>
        </section>

        <section className="site-panel px-5 py-5 lg:px-6 lg:py-6">
          <div className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-xl leading-tight font-medium tracking-[-0.04em] text-foreground lg:text-2xl">
                Draft an email
              </h2>
              <p className="text-sm leading-7 text-muted-foreground">
                Fill this out and open a pre-addressed email with your details included.
              </p>
            </div>

            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
              }}
            >
              <label className="grid gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground">Name</span>
                <input
                  className="border border-border/70 bg-background/80 px-3 py-3 text-sm text-foreground outline-none transition-colors focus:border-primary/45"
                  name="name"
                  onChange={(event) => {
                    setFormState((current) => ({ ...current, name: event.target.value }));
                  }}
                  placeholder="Your name"
                  type="text"
                  value={formState.name}
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground">Email</span>
                <input
                  className="border border-border/70 bg-background/80 px-3 py-3 text-sm text-foreground outline-none transition-colors focus:border-primary/45"
                  name="email"
                  onChange={(event) => {
                    setFormState((current) => ({ ...current, email: event.target.value }));
                  }}
                  placeholder="name@example.com"
                  type="email"
                  value={formState.email}
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs font-medium tracking-wide text-muted-foreground">Message</span>
                <textarea
                  className="min-h-36 border border-border/70 bg-background/80 px-3 py-3 text-sm leading-7 text-foreground outline-none transition-colors focus:border-primary/45"
                  name="message"
                  onChange={(event) => {
                    setFormState((current) => ({ ...current, message: event.target.value }));
                  }}
                  placeholder="Tell me a little about what you want to discuss."
                  value={formState.message}
                />
              </label>

              <Button asChild className="mt-1 w-fit gap-2">
                <a href={mailtoHref}>
                  Open email draft
                  <RiSendPlaneLine aria-hidden="true" className="size-4" />
                </a>
              </Button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
