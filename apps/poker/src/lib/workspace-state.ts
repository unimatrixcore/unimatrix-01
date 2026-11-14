import { pokerWorkspaceStateSchema, type PokerWorkspaceState } from "@unimatrix/shared";

const key = "poker-lab:workspace:v1";
export function readWorkspaceState(): PokerWorkspaceState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 4096) return {};
    const result = pokerWorkspaceStateSchema.safeParse(JSON.parse(raw) as unknown);
    return result.success ? result.data : {};
  } catch {
    return {};
  }
}
export function rememberWorkspaceState(patch: Partial<PokerWorkspaceState>): void {
  try {
    const result = pokerWorkspaceStateSchema.safeParse({ ...readWorkspaceState(), ...patch });
    if (result.success) localStorage.setItem(key, JSON.stringify(result.data));
  } catch {
    /* Preferences do not block the workspace when storage is unavailable. */
  }
}
export function rememberWorkspaceLocation(): void {
  const path = window.location.pathname;
  const result = pokerWorkspaceStateSchema.safeParse({ path });
  if (!result.success) return;
  rememberWorkspaceState({
    path: result.data.path,
    ...(!["/gameplay", "/training"].includes(path) ? { ocrPath: path } : {}),
  });
}
export function restoreWorkspaceLocation(): () => void {
  if (["/", "/index.html"].includes(window.location.pathname)) {
    const saved = readWorkspaceState().path;
    if (saved) history.replaceState(null, "", saved);
  }
  rememberWorkspaceLocation();
  for (const event of ["poker-workspace-change", "poker-ocr-location", "pagehide"])
    window.addEventListener(event, rememberWorkspaceLocation);
  const visibility = () => {
    if (document.hidden) rememberWorkspaceLocation();
  };
  document.addEventListener("visibilitychange", visibility);
  return () => {
    for (const event of ["poker-workspace-change", "poker-ocr-location", "pagehide"])
      window.removeEventListener(event, rememberWorkspaceLocation);
    document.removeEventListener("visibilitychange", visibility);
  };
}
export function rememberWorkspaceScroll(
  workspace: "gameplay" | "training",
  point: { top: number; left: number },
): void {
  rememberWorkspaceState({ scroll: { ...readWorkspaceState().scroll, [workspace]: point } });
}
export function restoreWorkspaceScroll(
  region: HTMLElement,
  point: { top: number; left: number },
  done: () => void,
): () => void {
  let finished = false;
  const observer = new MutationObserver(apply);
  const resize = new ResizeObserver(apply);
  const timeout = window.setTimeout(finish, 15000);
  function finish() {
    if (finished) return;
    finished = true;
    observer.disconnect();
    resize.disconnect();
    clearTimeout(timeout);
    region.removeEventListener("load", apply, true);
    region.removeEventListener("wheel", finish);
    region.removeEventListener("touchstart", finish);
    region.removeEventListener("pointerdown", finish);
    region.removeEventListener("keydown", userKey);
    done();
  }
  function apply() {
    if (finished) return;
    region.scrollTop = point.top;
    region.scrollLeft = point.left;
    if (
      region.scrollHeight - region.clientHeight >= point.top &&
      region.scrollWidth - region.clientWidth >= point.left
    )
      finish();
  }
  function userKey(event: KeyboardEvent) {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      finish();
  }
  observer.observe(region, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  resize.observe(region);
  for (const child of region.children) resize.observe(child);
  region.addEventListener("load", apply, true);
  region.addEventListener("wheel", finish, { passive: true });
  region.addEventListener("touchstart", finish, { passive: true });
  region.addEventListener("pointerdown", finish, { passive: true });
  region.addEventListener("keydown", userKey);
  apply();
  return finish;
}
