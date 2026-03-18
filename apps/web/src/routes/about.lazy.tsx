import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  RiGithubLine,
  RiLoader4Line,
  RiMailLine,
  RiPulseLine,
  RiSendPlaneLine,
} from "@remixicon/react";

import { homeContent } from "@/features/content/site-content";
import { statusSnapshotQueryOptions } from "@/features/status/queries/get-status-snapshot";
import { Badge, Button, cn } from "@unimatrix/ui/public";

const emailAddress = "gwen.phalan@gmail.com";
const githubProfileUrl = "https://github.com/gwenphalan";
const projectRepoUrl = "https://github.com/unimatrixcore/unimatrix-01";

export const Route = createLazyFileRoute("/about")({
  component: AboutRoute,
});

function AboutRoute() {
  const { data, isFetching } = useQuery(statusSnapshotQueryOptions());
  const [formState, setFormState] = useState({ email: "", message: "", name: "" });

  const mailtoHref = useMemo(() => {
    const subject = formState.name
      ? `Portfolio inquiry from ${formState.name}`
      : "Portfolio inquiry";
    const lines = [
      formState.name ? `Name: ${formState.name}` : undefined,
      formState.email ? `Email: ${formState.email}` : undefined,
      "",
      formState.message || "I'd like to get in touch about your work.",
    ].filter(Boolean);

    return `mailto:${emailAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  }, [formState.email, formState.message, formState.name]);

  return (
    <div className="space-y-9 lg:space-y-10">
      <header className="grid gap-7 border-b border-border/70 pb-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <div className="space-y-3">
          <p className="site-label">About</p>
          <p className="text-sm leading-7 text-muted-foreground">
            Background, contact details, and a simple way to start a conversation.
          </p>
        </div>

        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>About and contact</Badge>
            <Badge variant="outline">Open to thoughtful inquiries</Badge>
            <Badge className={cn("gap-1.5", isFetching && "animate-pulse")} variant="secondary">
              <RiLoader4Line
                aria-hidden="true"
                className={cn("size-3.5", isFetching && "animate-spin")}
              />
              System check {isFetching ? "updating" : "ready"}
            </Badge>
          </div>

          <div className="space-y-3">
            <h1 className="max-w-5xl text-4xl leading-[0.9] font-medium tracking-[-0.07em] text-foreground lg:text-[3.6rem]">
              I build reliable TypeScript systems and write about how they hold together.
            </h1>
            <p className="max-w-3xl text-base leading-8 text-foreground/88">
              {homeContent.frontmatter.intro}
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <div className="site-panel px-5 py-4">
            <p className="site-label">About me</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              Backend-leaning TypeScript developer, cybersecurity student, open-source builder, and
              systems-focused writer.
            </p>
          </div>

          <div className="site-panel px-5 py-4">
            <p className="site-label">Best fit</p>
            <p className="mt-3 text-sm leading-7 text-foreground/88">
              API design, typed contracts, platform work, security-minded engineering, and clear
              documentation around complex systems.
            </p>
          </div>

          <div className="site-panel px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p className="site-label">System check</p>
              <RiPulseLine aria-hidden="true" className="size-4 text-primary" />
            </div>
            <div className="mt-3 space-y-2 text-sm leading-7 text-foreground/88">
              <p>
                API: <span className="text-foreground">{data?.service ?? "pending"}</span>
              </p>
              <p>
                Status: <span className="text-foreground">{data?.status ?? "pending"}</span>
              </p>
              <p className="text-muted-foreground">Last checked {data?.checkedAt ?? "just now"}</p>
            </div>
          </div>
        </aside>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(22rem,0.85fr)]">
          <section className="site-panel px-5 py-5 lg:px-7 lg:py-7">
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="site-label">Contact details</p>
                <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
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
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">{emailAddress}</p>
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
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">github.com/gwenphalan</p>
                </a>

                <a
                  className="site-atlas-link border border-border/70 bg-background/72 px-4 py-4 transition-colors hover:border-primary/40 hover:bg-secondary/26 md:col-span-2"
                  href={projectRepoUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <div className="flex items-center gap-2 text-foreground">
                    <RiGithubLine aria-hidden="true" className="size-4 text-primary" />
                    <span className="text-sm font-medium">This site repository</span>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    View the repo that powers this portfolio and its content pipeline.
                  </p>
                </a>
              </div>
            </div>
          </section>

          <section className="site-panel px-5 py-5 lg:px-6 lg:py-6">
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="site-label">Inquiry form</p>
                <h2 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
                  Draft an email
                </h2>
                <p className="text-sm leading-7 text-muted-foreground">
                  Fill this out and open a pre-addressed email with your details already included.
                </p>
              </div>

              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                }}
              >
                <label className="grid gap-2">
                  <span className="site-label">Name</span>
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
                  <span className="site-label">Email</span>
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
                  <span className="site-label">Message</span>
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
    </div>
  );
}
