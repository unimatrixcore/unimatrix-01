import { useAuth } from "@unimatrix/auth/react";
import { useId, type ReactNode } from "react";

import { PUBLIC_SITE_URL, buildSignInHref } from "@/lib/config";

/**
 * A titled panel inside a gated section, used for each managed collection
 * and for the editor page.
 */
export function SectionPanel({
  actions,
  children,
  className,
  description,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: string;
  title: string;
}) {
  const headingId = useId();

  return (
    // A labelled `section` is a landmark: with two of these side by side, the
    // heading is what tells a screen-reader user which collection's controls
    // they are in.
    <section aria-labelledby={headingId} className={className}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 bg-card px-5 py-5 lg:px-6 lg:py-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
          <div className="space-y-1">
            <h2
              className="text-lg leading-tight font-medium tracking-[-0.03em] text-foreground"
              id={headingId}
            >
              {title}
            </h2>
            {description === undefined ? null : (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions}
        </div>

        {children}
      </div>
    </section>
  );
}

const EXIT_LINK_CLASS = "text-sm text-primary underline underline-offset-4";

/**
 * Shown in place of a gated section for a visitor without the permission it
 * requires.
 *
 * Both links are plain anchors: the site and the auth hub are separate origins
 * from this one, so neither is reachable by a router `Link`.
 *
 * The signed-out branch only renders where `requireSignIn` is off — in
 * production `RequireSignedIn` bounces a signed-out visitor to the auth hub
 * before this panel can mount, so anyone who reaches it there is signed in and
 * simply lacks the permission. Dev is the case that needs the sign-in door:
 * `apps/web` no longer has one, so without this the panel is the end of the
 * road.
 */
export function SectionAccessDenied({
  authAppUrl,
  description,
}: {
  authAppUrl: string;
  /** What the section manages, named so the denied panel says what was blocked. */
  description: string;
}) {
  const { isSignedIn } = useAuth();

  return (
    <div className="site-panel space-y-3 px-5 py-5 lg:px-6 lg:py-6">
      <h2 className="text-lg font-medium text-foreground">You do not have access to this page.</h2>
      <p className="text-sm text-muted-foreground">
        {description}{" "}
        {isSignedIn === true
          ? "Your account does not carry admin access."
          : "Sign in with an admin account to use it."}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        {isSignedIn === true ? null : (
          <a className={EXIT_LINK_CLASS} href={buildSignInHref(authAppUrl, window.location.href)}>
            Sign in
          </a>
        )}
        <a className={EXIT_LINK_CLASS} href={PUBLIC_SITE_URL}>
          Return to the site
        </a>
      </div>
    </div>
  );
}
