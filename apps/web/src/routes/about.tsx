import { createFileRoute } from "@tanstack/react-router";

import { statusSnapshotQueryOptions } from "@/features/status/queries/get-status-snapshot";

export const Route = createFileRoute("/about")({
  loader: ({ context }) => context.queryClient.ensureQueryData(statusSnapshotQueryOptions()),
});
