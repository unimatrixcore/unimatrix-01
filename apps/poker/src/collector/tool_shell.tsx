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

export function mountToolShell() {
  const host = document.getElementById("tool-shell");
  const workspace = document.getElementById("section-ocr-data");
  if (!host || !workspace) return;
  workspace.remove();
  const gameplay = window.location.pathname === "/gameplay";
  // Full navigation lets each workspace own its lifecycle and recording keys.
  // Capture the rail's links before the memory router handles them.
  host.addEventListener(
    "click",
    (event) => {
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
      // Active links still close the shared rail through its normal click handler.
      if ((path === "/gameplay") === gameplay) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(path);
    },
    { capture: true },
  );
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  flushSync(() => {
    createRoot(host).render(
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
            {gameplay ? <Gameplay /> : <NativeWorkspace element={workspace} />}
          </ToolShell>
        </RouterContextProvider>
      </LabQueryProvider>,
    );
  });
}
