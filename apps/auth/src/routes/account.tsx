import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/account")({
  head: () => ({
    meta: [{ title: "Unimatrix Accounts - Account" }],
  }),
});
