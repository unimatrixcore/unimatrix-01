import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RequireAuth } from "@/features/auth/require-auth";

// No VITE_CLERK_PUBLISHABLE_KEY is stubbed here, matching the default,
// auth-disabled build: `RequireAuth` must render its children unchanged and
// must never redirect, since there is nothing to protect against without a
// configured Clerk key.
describe("RequireAuth (auth disabled)", () => {
  it("renders children without redirecting", () => {
    render(
      <RequireAuth>
        <p>protected content</p>
      </RequireAuth>,
    );

    expect(screen.getByText("protected content")).toBeInTheDocument();
  });
});
