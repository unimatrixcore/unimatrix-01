import { createFileRoute } from "@tanstack/react-router";

export interface SignInSearch {
  redirect_url?: string;
}

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search: Record<string, unknown>): SignInSearch =>
    typeof search.redirect_url === "string" ? { redirect_url: search.redirect_url } : {},
  head: () => ({
    meta: [{ title: "Unimatrix Accounts - Sign in" }],
  }),
});
