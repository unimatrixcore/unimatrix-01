import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAuth, mockUsePermissions } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  mockUsePermissions: vi.fn(),
}));

// Asserting either branch against a real Clerk session would need a live key.
vi.mock("@unimatrix/auth/react", () => ({
  useAuth: mockUseAuth,
  usePermissions: mockUsePermissions,
}));

// The gate is what is under test; the page it guards has its own suite and
// would need the API client mocked to render at all.
vi.mock("@/features/deploys/deploys-page", () => ({
  DeploysPage: () => <p>the deploys console</p>,
}));

const { Route } = await import("../src/routes/deploys.lazy.js");

function renderRoute() {
  const Component = Route.options.component;

  if (Component === undefined) {
    throw new Error("the deploys route has no component");
  }

  render(<Component />);
}

describe("/deploys", () => {
  beforeEach(() => {
    mockUseAuth.mockReturnValue({ isSignedIn: true });
    // The route reads its context through the router, which is not mounted
    // here — the gate is the unit, not the route tree.
    vi.spyOn(Route, "useRouteContext").mockReturnValue({
      runtimeConfig: { authAppUrl: "https://auth.example.test" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The same predicate `apps/api` gates its deploys routes on. A session
   * without it would otherwise be shown a console whose every call comes back
   * a 403.
   */
  it("denies a signed-in session that does not carry admin access", () => {
    mockUsePermissions.mockReturnValue({ isLoaded: true, permissions: {} });

    renderRoute();

    expect(screen.queryByText("the deploys console")).not.toBeInTheDocument();
    expect(screen.getByText("You do not have access to this page.")).toBeInTheDocument();
  });

  it("renders the console for a session that does", () => {
    mockUsePermissions.mockReturnValue({
      isLoaded: true,
      permissions: { auth: ["admin"] },
    });

    renderRoute();

    expect(screen.getByText("the deploys console")).toBeInTheDocument();
  });

  /**
   * Permissions read as absent until Clerk has resolved the session, so
   * deciding before `isLoaded` would flash the denied panel at every admin on
   * every cold load.
   */
  it("decides nothing until the session has loaded", () => {
    mockUsePermissions.mockReturnValue({ isLoaded: false, permissions: undefined });

    renderRoute();

    expect(screen.queryByText("the deploys console")).not.toBeInTheDocument();
    expect(screen.queryByText("You do not have access to this page.")).not.toBeInTheDocument();
  });
});
