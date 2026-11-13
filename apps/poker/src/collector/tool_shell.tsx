import { LabQueryProvider, labListOptions, labQueryClient } from "../lib/background-lists";
import { backgroundListQueryOptions, usePrefetchList } from "@unimatrix/instant-list";
import { pokerLabListItemSchema, pokerGameplaySessionSchema } from "@unimatrix/shared";
import {
  clearLabPageHandoff,
  handoffGeneration,
  storeLabPageHandoff,
} from "../lib/lab-page-handoff";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { ToolShell } from "@unimatrix/chrome/tool";
import { Gameplay } from "./gameplay";
import { BranchSelector } from "./branch_selector";

function OcrIcon({ className }: { className?: string | undefined }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
      <rect x="7" y="7" width="10" height="10" rx="1" />
    </svg>
  );
}

// React owns the chrome; the existing collector retains ownership of its DOM
// and handlers. Move those nodes once so labels, recording, and review survive
// every sidebar toggle without being recreated by React.
function NativeWorkspace({ element }: { element: HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.appendChild(element);
  }, [element]);
  return <div ref={host} className="collector-native-host" />;
}

function GameplayIcon({ className }: { className?: string | undefined }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="13" rx="1" />
      <path d="m10 8 5 3-5 3Z" />
      <path d="M8 21h8m-4-4v4" />
    </svg>
  );
}

function RailPrefetch({ host, gameplay }: { host: HTMLElement; gameplay: boolean }) {
  const [datasetId, setDatasetId] = useState(
    () => localStorage.getItem("ocr:active-dataset") || "",
  );
  const currentDataset = useRef(datasetId);
  const queue = labListOptions<ReturnType<typeof pokerLabListItemSchema.parse>>({
    path: "/api/queue",
    datasetId,
    query: { order: "newest" },
    getItemId: (item) => item.id,
    parseItem: (item) => pokerLabListItemSchema.parse(item),
    pageSize: 100,
    enabled: !!datasetId,
  });
  const games = labListOptions<ReturnType<typeof pokerGameplaySessionSchema.parse>>({
    path: "/api/gameplay",
    query: { archived: "0" },
    getItemId: (item) => item.id,
    parseItem: (item) => pokerGameplaySessionSchema.parse(item),
    pageSize: 100,
  });
  games.queryKey = [...games.queryKey, 0];
  const queueIntent = usePrefetchList(queue),
    gamesIntent = usePrefetchList(games);
  useEffect(() => {
    const update = () => {
      const next = localStorage.getItem("ocr:active-dataset") || "";
      if (next !== currentDataset.current) clearLabPageHandoff();
      currentDataset.current = next;
      setDatasetId(next);
    };
    window.addEventListener("poker-dataset-change", update);
    return () => {
      window.removeEventListener("poker-dataset-change", update);
    };
  }, []);
  useEffect(() => {
    const prefetch = (event: Event) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link) return;
      const path = new URL(link.href, window.location.href).pathname;
      if (path === "/gameplay" && !gameplay) {
        const generation = handoffGeneration();
        gamesIntent.onMouseEnter();
        void labQueryClient
          .fetchInfiniteQuery({ ...backgroundListQueryOptions(games), pages: 1 })
          .then((data) => {
            const page = data.pages[0];
            if (page)
              storeLabPageHandoff(
                {
                  path: "/api/gameplay",
                  datasetId: null,
                  query: { archived: "0" },
                  storedAt: Date.now(),
                  page: { ...page, hasMore: page.nextCursor !== null },
                },
                generation,
              );
          })
          .catch(() => {});
      } else if (path === "/collection" && gameplay && datasetId) {
        const generation = handoffGeneration();
        queueIntent.onMouseEnter();
        void labQueryClient
          .fetchInfiniteQuery({ ...backgroundListQueryOptions(queue), pages: 1 })
          .then((data) => {
            const page = data.pages[0];
            if (page)
              storeLabPageHandoff(
                {
                  path: "/api/queue",
                  datasetId,
                  query: { order: "newest" },
                  storedAt: Date.now(),
                  page: { ...page, hasMore: page.nextCursor !== null },
                },
                generation,
              );
          })
          .catch(() => {});
      }
    };
    host.addEventListener("mouseover", prefetch);
    host.addEventListener("focusin", prefetch);
    return () => {
      host.removeEventListener("mouseover", prefetch);
      host.removeEventListener("focusin", prefetch);
    };
  }, [host, gameplay, datasetId, queueIntent.onMouseEnter, gamesIntent.onMouseEnter]);
  return null;
}

function WorkspaceShell({ host, workspace }: { host: HTMLElement; workspace: HTMLElement }) {
  const [gameplay, setGameplay] = useState(window.location.pathname === "/gameplay");
  const [gameplayVisited, setGameplayVisited] = useState(gameplay);
  const active = useRef(gameplay);
  const leavingGameplay = useRef<() => Promise<void>>(async () => {});
  const ocrLocation = useRef({
    path: gameplay ? "/collection" : window.location.pathname,
    state: history.state as unknown,
  });
  const transition = useRef(Promise.resolve());
  const generation = useRef(0);
  const committed = useRef({ path: window.location.pathname, state: history.state as unknown });
  const gameplayScroll = useRef({ top: 0, left: 0 });
  const ocrFinished = useRef(false);
  const ocrWatchdog = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active.current)
      queueMicrotask(() => {
        void window
          .startPokerOcr()
          .then(() => {
            ocrFinished.current = true;
          })
          .catch(() => {});
      });
    const switchTo = (next: boolean, pop = false, state?: unknown) => {
      const ticket = ++generation.current;
      const destination = pop ? { path: window.location.pathname, state } : null;
      transition.current = transition.current
        .then(async () => {
          if (ticket !== generation.current) return;
          if (active.current === next) return;
          if (active.current) await leavingGameplay.current();
          else {
            if (!pop)
              ocrLocation.current = {
                path: window.location.pathname,
                state: history.state as unknown,
              };
            await window.leavePokerOcr?.();
          }
          if (ticket !== generation.current) return;
          const deferred = next ? undefined : window.pokerOcrDeferredLocation;
          if (deferred) {
            ocrLocation.current = deferred;
            delete window.pokerOcrDeferredLocation;
          }
          const region = document.getElementById("main-content");
          clearLabPageHandoff();
          if (next) {
            clearTimeout(ocrWatchdog.current);
            document.getElementById("loading-overlay")?.classList.remove("active");
            window.CollectorScroll?.suspend();
          } else if (region)
            gameplayScroll.current = { top: region.scrollTop, left: region.scrollLeft };
          if (!pop) {
            const path = next ? "/gameplay" : ocrLocation.current.path;
            history.pushState(next ? { pokerGameplay: true } : ocrLocation.current.state, "", path);
          } else if (deferred) {
            history.replaceState(deferred.state, "", deferred.path);
          }
          committed.current = deferred ??
            destination ?? {
              path: window.location.pathname,
              state: history.state as unknown,
            };
          active.current = next;
          flushSync(() => {
            if (next) setGameplayVisited(true);
            setGameplay(next);
          });
          window.dispatchEvent(new Event("poker-workspace-change"));
          if (next && region) {
            region.scrollTop = gameplayScroll.current.top;
            region.scrollLeft = gameplayScroll.current.left;
          } else window.CollectorScroll?.resume();
          if (region) {
            region.tabIndex = -1;
            region.focus({ preventScroll: true });
          }
          if (!next) {
            const cold = !ocrFinished.current;
            if (cold) document.getElementById("loading-overlay")?.classList.add("active");
            ocrWatchdog.current = cold
              ? window.setTimeout(() => {
                  if (ocrFinished.current) return;
                  window.pokerStartupTimedOut = true;
                  document.getElementById("loading-overlay")?.classList.remove("active");
                  const toast = document.createElement("div");
                  toast.className = "toast error";
                  toast.append("The first view timed out. ");
                  const retry = document.createElement("button");
                  retry.textContent = "Retry";
                  retry.onclick = () => {
                    window.location.reload();
                  };
                  toast.append(retry);
                  document.getElementById("toast-container")?.appendChild(toast);
                }, 15000)
              : undefined;
            void window
              .startPokerOcr()
              .then(() => {
                ocrFinished.current = true;
                clearTimeout(ocrWatchdog.current);
                if (ticket !== generation.current || active.current) return;
                if (pop && (deferred?.state || state) && window.onpopstate)
                  window.onpopstate(
                    new PopStateEvent("popstate", { state: deferred?.state ?? state }),
                  );
              })
              .catch((error: unknown) => {
                clearTimeout(ocrWatchdog.current);
                if (ticket !== generation.current || active.current) return;
                document.getElementById("loading-overlay")?.classList.remove("active");
                const toast = document.createElement("div");
                toast.className = "toast error";
                toast.textContent = error instanceof Error ? error.message : String(error);
                const retry = document.createElement("button");
                retry.textContent = "Retry";
                retry.onclick = () => {
                  window.location.reload();
                };
                toast.append(" ", retry);
                document.getElementById("toast-container")?.appendChild(toast);
              });
          }
        })
        .catch((error: unknown) => {
          if (ticket !== generation.current) return;
          if (pop && active.current !== next)
            history.replaceState(committed.current.state, "", committed.current.path);
          const toast = document.createElement("div");
          toast.className = "toast error";
          toast.textContent = error instanceof Error ? error.message : String(error);
          if (!next && active.current === next) {
            document.getElementById("loading-overlay")?.classList.remove("active");
            const retry = document.createElement("button");
            retry.textContent = "Retry";
            retry.onclick = () => {
              window.location.reload();
            };
            toast.append(" ", retry);
          }
          document.getElementById("toast-container")?.appendChild(toast);
        });
    };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (
        !link ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const path = new URL(link.href, window.location.href).pathname;
      if (path !== "/gameplay" && path !== "/collection") return;
      if ((path === "/gameplay") === active.current) return;
      event.preventDefault();
      event.stopPropagation();
      switchTo(path === "/gameplay");
    };
    const popstate = (event: PopStateEvent) => {
      const next = window.location.pathname === "/gameplay";
      if (next === active.current) {
        ++generation.current;
        committed.current = { path: window.location.pathname, state: event.state as unknown };
        if (!next)
          queueMicrotask(() => {
            ocrLocation.current = {
              path: window.location.pathname,
              state: history.state as unknown,
            };
          });
        return;
      }
      event.stopImmediatePropagation();
      switchTo(next, true, event.state as unknown);
    };
    const ocrLocationChanged = () => {
      if (!active.current)
        committed.current = ocrLocation.current = {
          path: window.location.pathname,
          state: history.state as unknown,
        };
    };
    host.addEventListener("click", click, true);
    window.addEventListener("popstate", popstate, true);
    window.addEventListener("poker-ocr-location", ocrLocationChanged);
    return () => {
      host.removeEventListener("click", click, true);
      window.removeEventListener("popstate", popstate, true);
      window.removeEventListener("poker-ocr-location", ocrLocationChanged);
    };
  }, [host]);
  return (
    <LabQueryProvider>
      <RailPrefetch host={host} gameplay={gameplay} />
      <RouterContextProvider router={router}>
        <ToolShell
          className="collector-shell"
          homeLabel="Poker Lab"
          logoSrc="/static/ui/poker-chip.svg"
          accountControl={({ collapsed }) => <BranchSelector collapsed={collapsed} />}
          sections={[
            { label: "OCR Data", to: "/collection", active: !gameplay, icon: OcrIcon },
            { label: "Gameplay", to: "/gameplay", active: gameplay, icon: GameplayIcon },
          ]}
          showFooter={false}
          scroll="section"
          width="wide"
        >
          <div style={{ display: gameplay ? "none" : undefined }}>
            <NativeWorkspace element={workspace} />
          </div>
          <div style={{ display: gameplay ? undefined : "none" }}>
            {gameplayVisited && <Gameplay active={gameplay} onLeave={leavingGameplay} />}
          </div>
        </ToolShell>
      </RouterContextProvider>
    </LabQueryProvider>
  );
}

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

export function mountToolShell() {
  const host = document.getElementById("tool-shell");
  const workspace = document.getElementById("section-ocr-data");
  if (!host || !workspace) return;
  workspace.remove();
  flushSync(() => {
    createRoot(host).render(<WorkspaceShell host={host} workspace={workspace} />);
  });
}
