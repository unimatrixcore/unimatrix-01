import { createLazyFileRoute } from "@tanstack/react-router";

export const Route = createLazyFileRoute("/origin-migration")({
  component: OriginMigrationRoute,
});

function OriginMigrationRoute() {
  return <p>Transferring saved progress…</p>;
}
