import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [{ title: "Unimatrix Accounts - Admin" }],
  }),
});
