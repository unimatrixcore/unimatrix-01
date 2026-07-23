import { Link, createLazyFileRoute } from "@tanstack/react-router";
import { RiShieldUserLine, RiUserSettingsLine } from "@remixicon/react";

import { SignedIn, SignedOut, usePermissions } from "@unimatrix/auth/react";
import { Button, Card } from "@unimatrix/ui/public";

export const Route = createLazyFileRoute("/")({
  component: IndexRoute,
});

function IndexRoute() {
  return (
    <div className="space-y-8">
      <SignedOut>
        <WelcomePanel />
      </SignedOut>
      <SignedIn>
        <DashboardPanel />
      </SignedIn>
    </div>
  );
}

function WelcomePanel() {
  return (
    <Card className="site-panel max-w-2xl px-6 py-8 lg:px-8 lg:py-10">
      <div className="space-y-5">
        <h1 className="text-3xl leading-tight font-medium tracking-[-0.05em] text-foreground">
          Unimatrix Accounts
        </h1>
        <p className="max-w-xl text-sm leading-7 text-muted-foreground">
          Sign in to manage your Unimatrix account, or create a new one to get
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

function DashboardPanel() {
  const { isAdmin } = usePermissions();

  return (
    <Card className="site-panel max-w-2xl px-6 py-8 lg:px-8 lg:py-10">
      <div className="space-y-5">
        <h1 className="text-3xl leading-tight font-medium tracking-[-0.05em] text-foreground">
          Welcome back
        </h1>
        <p className="max-w-xl text-sm leading-7 text-muted-foreground">
          Manage your profile, connected accounts, and security settings.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild className="w-fit gap-2">
            <Link to="/account">
              <RiUserSettingsLine aria-hidden="true" className="size-4" />
              Manage account
            </Link>
          </Button>
          {isAdmin() ? (
            <Button asChild className="w-fit gap-2" variant="outline">
              <Link to="/admin">
                <RiShieldUserLine aria-hidden="true" className="size-4" />
                Admin panel
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
