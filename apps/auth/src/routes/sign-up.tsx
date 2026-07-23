import { createFileRoute } from "@tanstack/react-router";

export interface SignUpSearch {
  redirect_url?: string;
}

export const Route = createFileRoute("/sign-up")({
  validateSearch: (search: Record<string, unknown>): SignUpSearch =>
    typeof search.redirect_url === "string" ? { redirect_url: search.redirect_url } : {},
  head: () => ({
    meta: [{ title: "Unimatrix Accounts - Sign up" }],
  }),
});
