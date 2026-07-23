import { queryOptions } from "@tanstack/react-query";

export type ProjectLiveStatus = "live" | "offline";

const LIVE_STATUS_CHECK_TIMEOUT_MS = 5000;
const LIVE_STATUS_REFETCH_INTERVAL_MS = 60_000;
const LIVE_STATUS_STALE_TIME_MS = 30_000;

export async function checkProjectLiveStatus(liveUrl: string): Promise<ProjectLiveStatus> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, LIVE_STATUS_CHECK_TIMEOUT_MS);

  try {
    await fetch(liveUrl, {
      cache: "no-store",
      method: "HEAD",
      mode: "no-cors",
      signal: abortController.signal,
    });

    return "live";
  } catch {
    return "offline";
  } finally {
    clearTimeout(timeoutId);
  }
}

export function projectLiveStatusQueryOptions(liveUrl: string) {
  return queryOptions({
    queryFn: () => checkProjectLiveStatus(liveUrl),
    queryKey: ["project-live-status", liveUrl],
    refetchInterval: LIVE_STATUS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: LIVE_STATUS_STALE_TIME_MS,
  });
}
