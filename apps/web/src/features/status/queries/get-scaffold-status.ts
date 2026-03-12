import { queryOptions } from "@tanstack/react-query";

export type ScaffoldStatus = {
  checkedAt: string;
  mode: string;
  queryStatus: string;
  routerStatus: string;
};

async function getScaffoldStatus(): Promise<ScaffoldStatus> {
  await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });

  return {
    checkedAt: new Date().toLocaleTimeString(),
    mode: import.meta.env.MODE,
    queryStatus: "QueryClientProvider is active and route data can be prefetched.",
    routerStatus: "TanStack Router file-based routing is active.",
  };
}

export function scaffoldStatusQueryOptions() {
  return queryOptions({
    queryFn: getScaffoldStatus,
    queryKey: ["scaffold-status"],
    staleTime: 1000 * 60,
  });
}
