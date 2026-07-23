import { Link, Navigate, createLazyFileRoute } from "@tanstack/react-router";

import { SignedIn, SignedOut } from "@unimatrix/auth/react";
import { Button, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  return (
    <>
      {/* Already signed in: nothing to do here — go straight to the account
          screen. Services link people to /sign-in directly, so `/` is only
          hit by someone browsing to the auth app on its own. */}
      <SignedIn>
        <Navigate to="/account" replace />
      </SignedIn>
      <SignedOut>
        <WelcomeCard />
      </SignedOut>
    </>
  );
}

function WelcomeCard() {
  return (
    <Card className="w-full max-w-md px-6 py-8">
      <div className="space-y-5">
        <h1 className="text-2xl leading-tight font-medium tracking-[-0.05em] text-foreground">
          Unimatrix Accounts
        </h1>
        <p className="text-sm leading-7 text-muted-foreground">
          Sign in to your Unimatrix account, or create a new one to get
          started.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="w-fit">
            <Link to="/sign-in">Sign in</Link>
          </Button>
          <Button asChild className="w-fit" variant="outline">
            <Link to="/sign-up">Sign up</Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}
