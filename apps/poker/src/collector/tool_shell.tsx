import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { ToolShell } from "@unimatrix/chrome/tool";
import { GraduationCap } from "lucide-react";
import { LabQueryProvider } from "../lib/background-lists";
import { Gameplay } from "./gameplay";
import { OcrTraining } from "./ocr_training";
import { AppSettings } from "./app_settings";
import { BenchmarkArchive } from "./benchmark-archive";
import {
  readWorkspaceState,
  rememberWorkspaceScroll,
  restoreWorkspaceScroll,
} from "../lib/workspace-state";

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
type Workspace = "archive" | "gameplay" | "training";
const workspaceAt = (): Workspace =>
  window.location.pathname === "/training"
    ? "training"
    : window.location.pathname === "/gameplay"
      ? "gameplay"
      : "archive";
function WorkspaceShell({ host }: { host: HTMLElement }) {
  const [current, setCurrent] = useState<Workspace>(workspaceAt);
  const [gameplayVisited, setGameplayVisited] = useState(current === "gameplay");
  const [trainingVisited, setTrainingVisited] = useState(current === "training");
  const active = useRef(current);
  const leavingGameplay = useRef<() => Promise<void>>(async () => {});
  const transition = useRef(Promise.resolve());
  const generation = useRef(0);
  const restoring = useRef(false);
  const committed = useRef({ path: window.location.pathname, state: history.state as unknown });
  const scroll = useRef(readWorkspaceState().scroll || {});
  useLayoutEffect(() => {
    const region = document.getElementById("main-content");
    if (!region || current === "archive") return;
    restoring.current = true;
    return restoreWorkspaceScroll(region, scroll.current[current] || { top: 0, left: 0 }, () => {
      restoring.current = false;
    });
  }, [current]);
  useEffect(() => {
    const region = document.getElementById("main-content");
    const saveScroll = () => {
      if (!region || restoring.current || active.current === "archive") return;
      const point = { top: region.scrollTop, left: region.scrollLeft };
      scroll.current[active.current] = point;
      rememberWorkspaceScroll(active.current, point);
    };
    function navigate(next: Workspace, pop = false) {
      const ticket = ++generation.current;
      transition.current = transition.current
        .then(async () => {
          if (ticket !== generation.current || next === active.current) return;
          if (active.current === "gameplay") await leavingGameplay.current();
          if (ticket !== generation.current) return;
          saveScroll();
          if (!pop)
            history.pushState(
              { pokerWorkspace: next },
              "",
              next === "archive" ? "/collection" : `/${next}`,
            );
          committed.current = { path: window.location.pathname, state: history.state as unknown };
          active.current = next;
          if (next === "gameplay") setGameplayVisited(true);
          if (next === "training") setTrainingVisited(true);
          setCurrent(next);
          window.dispatchEvent(new Event("poker-workspace-change"));
        })
        .catch((reason: unknown) => {
          if (pop) history.replaceState(committed.current.state, "", committed.current.path);
          const toast = document.createElement("div");
          toast.className = "toast error";
          toast.textContent = reason instanceof Error ? reason.message : String(reason);
          document.getElementById("toast-container")?.appendChild(toast);
        });
    }
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
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        !["/gameplay", "/training", "/collection"].includes(url.pathname)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      navigate(
        url.pathname === "/gameplay"
          ? "gameplay"
          : url.pathname === "/training"
            ? "training"
            : "archive",
      );
    };
    const popstate = () => {
      navigate(workspaceAt(), true);
    };
    const archive = () => {
      navigate("archive");
    };
    host.addEventListener("click", click, true);
    window.addEventListener("popstate", popstate);
    window.addEventListener("poker-open-benchmark-archive", archive);
    region?.addEventListener("scroll", saveScroll, { passive: true });
    window.addEventListener("pagehide", saveScroll);
    if (active.current === "archive")
      document.getElementById("loading-overlay")?.classList.remove("active");
    return () => {
      host.removeEventListener("click", click, true);
      window.removeEventListener("popstate", popstate);
      window.removeEventListener("poker-open-benchmark-archive", archive);
      region?.removeEventListener("scroll", saveScroll);
      window.removeEventListener("pagehide", saveScroll);
    };
  }, [host]);
  return (
    <LabQueryProvider>
      <RouterContextProvider router={router}>
        <ToolShell
          className="collector-shell"
          homeLabel="Poker Lab"
          logoSrc="/static/ui/poker-chip.svg"
          accountControl={({ collapsed }) => <AppSettings collapsed={collapsed} />}
          sections={[
            {
              label: "Gameplay",
              to: "/gameplay",
              active: current === "gameplay",
              icon: GameplayIcon,
            },
            {
              label: "OCR Training",
              to: "/training",
              active: current === "training",
              icon: GraduationCap,
            },
          ]}
          showFooter={false}
          scroll="section"
          width="wide"
        >
          {current === "archive" && <BenchmarkArchive />}
          <div style={{ display: current === "gameplay" ? undefined : "none" }}>
            {gameplayVisited && (
              <Gameplay active={current === "gameplay"} onLeave={leavingGameplay} />
            )}
          </div>
          <div style={{ display: current === "training" ? undefined : "none" }}>
            {trainingVisited && <OcrTraining active={current === "training"} />}
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
  if (!host) return;
  document.getElementById("section-ocr-data")?.remove();
  createRoot(host).render(<WorkspaceShell host={host} />);
}
