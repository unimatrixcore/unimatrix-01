import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Surface } from "@/components/surface";
import { scaffoldStatusQueryOptions } from "@/features/status/queries/get-scaffold-status";

export const Route = createFileRoute("/status")({
  component: StatusRoute,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(scaffoldStatusQueryOptions()),
});

function StatusRoute() {
  const { data, isFetching } = useQuery(scaffoldStatusQueryOptions());

  return (
    <div className="route-stack">
      <Surface>
        <p className="eyebrow">Status route</p>
        <h2>Router and query providers are active</h2>
        <p className="body-copy">
          This route uses a local async query and a route loader that prefetches
          into the shared QueryClient.
        </p>
      </Surface>

      <Surface>
        <dl className="status-grid">
          <div>
            <dt>Router</dt>
            <dd>{data?.routerStatus}</dd>
          </div>
          <div>
            <dt>Query</dt>
            <dd>{data?.queryStatus}</dd>
          </div>
          <div>
            <dt>Mode</dt>
            <dd>{data?.mode}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{data?.checkedAt}</dd>
          </div>
        </dl>
        <p className="body-copy">
          Query refresh state: {isFetching ? "updating" : "idle"}
        </p>
      </Surface>
    </div>
  );
}
