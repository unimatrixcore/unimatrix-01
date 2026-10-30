export function isPlaybackRoute(hash = location.hash): boolean {
  const path = hash.replace(/^#!?/, "").split("?")[0]?.toLowerCase();
  return path === "/video" || path === "/playback";
}
