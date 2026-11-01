import { Link } from "@tanstack/react-router";
import { RiScales3Line, RiServerLine, RiTimeLine } from "@remixicon/react";
import type { DeployReconciliationResponse, DeployDeclaration } from "@unimatrix/shared";
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@unimatrix/ui/editor";

function relativeTime(value: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - value) / 60_000);
  if (minutes < 1) return "< 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function sourceHref(path: string): string {
  return `https://github.com/unimatrixcore/unimatrix-01/blob/main/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function ReconciliationPanel({
  snapshot,
  app,
  declaration,
  dokployUrl,
}: {
  snapshot: DeployReconciliationResponse;
  app: string;
  declaration?: DeployDeclaration | undefined;
  dokployUrl?: string | null;
}) {
  const result = snapshot.results.find((entry) => entry.appDir === app);
  const diff = result?.outcome === "diffed" ? result.diff : undefined;
  const matched = diff?.verdict === "matched" ? diff : undefined;
  const findings =
    matched?.envFindings.filter(
      (finding) =>
        finding.state !== "set" &&
        finding.state !== "optional-absent" &&
        finding.state !== "build-arg-runtime-copy",
    ) ?? [];
  const routing = matched?.routing;
  const routingCount =
    routing?.status === "drift"
      ? Number(routing.missingHosts.length > 0 || routing.unexpectedHosts.length > 0) +
        Number(routing.portMismatch)
      : 0;
  const count = findings.length + (matched?.settingFindings.length ?? 0) + routingCount;
  const title =
    snapshot.status === "not-checked"
      ? "Not checked"
      : snapshot.status === "checking"
        ? "Checking"
        : (snapshot.status === "read-failed" && result === undefined) || result?.outcome === "error"
          ? "Check unavailable"
          : !diff
            ? "No result for this service"
            : diff.verdict === "missing"
              ? "Awaiting setup"
              : diff.verdict === "ambiguous"
                ? "Service mapping is ambiguous"
                : count
                  ? `${count} to resolve`
                  : routing?.status === "unavailable"
                    ? "Routing unavailable"
                    : "In sync";
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge variant={count ? "destructive" : "outline"}>{title}</Badge>
          {snapshot.freshness === "stale" ? (
            <span className="text-xs text-amber-600 dark:text-amber-400">Stale snapshot</span>
          ) : null}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <RiTimeLine aria-hidden="true" className="size-3.5" />
              {snapshot.observedAt === null
                ? "No completed check"
                : `${relativeTime(snapshot.observedAt)} ago`}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {snapshot.nextRunAt === null
              ? "Next check not scheduled"
              : `Next check in ${Math.max(0, Math.ceil((snapshot.nextRunAt - Date.now()) / 60_000))}m`}
          </TooltipContent>
        </Tooltip>
      </div>
      {diff?.verdict === "missing" ? (
        <div className="flex items-center gap-3 border-b border-border py-3">
          <RiServerLine aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm">Service not created</span>
          <span className="ml-auto text-xs text-muted-foreground">Host-local setup required</span>
        </div>
      ) : null}
      {diff?.verdict === "ambiguous" ? (
        <p className="text-sm text-muted-foreground">
          {diff.matchCount} services matched this declaration. Resolve the service mapping before
          comparing configuration.
        </p>
      ) : null}
      {count ? (
        <div className="divide-y divide-border border-y border-border">
          {findings.map((finding) => {
            const source = declaration?.env.find((entry) => entry.name === finding.key)?.source;
            const sourceLabel =
              source?.kind === "literal"
                ? "config literal"
                : source?.kind === "secrets-store"
                  ? "secrets store"
                  : (source?.kind ?? "undeclared");
            return (
              <div key={finding.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-mono text-xs text-foreground">{finding.key}</p>
                  <div className="mt-1.5 flex items-center gap-2 text-xs">
                    <span
                      className={
                        finding.state === "undeclared" ? "text-amber-500" : "text-destructive"
                      }
                    >
                      {finding.state === "undeclared"
                        ? "Undeclared"
                        : finding.state === "blank"
                          ? "Blank value"
                          : "Missing value"}
                    </span>
                    <span className="text-muted-foreground">· {sourceLabel}</span>
                  </div>
                </div>
                {finding.state === "undeclared" ? (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button size="sm" variant="outline">
                        Review
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="rounded-none text-xs">
                      <p className="break-all font-mono">{finding.key}</p>
                      <p>
                        Keep: declare it in{" "}
                        {declaration?.configPath ?? "the deployment configuration"}.
                      </p>
                      {dokployUrl ? (
                        <a
                          href={dokployUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-4"
                        >
                          Remove in Dokploy ↗
                        </a>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                ) : source?.kind === "secrets-store" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/secrets">Open Secrets</Link>
                  </Button>
                ) : declaration ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={sourceHref(declaration.configPath)} target="_blank" rel="noreferrer">
                      Open source ↗
                    </a>
                  </Button>
                ) : null}
              </div>
            );
          })}
          {matched?.settingFindings.map((finding) => (
            <div key={finding.setting} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-xs">{finding.setting}</p>
                <p className="mt-1.5 break-all text-xs text-muted-foreground">
                  <span className="text-destructive">Different setting</span> · declared{" "}
                  {finding.declared} · Dokploy has {finding.actual}
                </p>
              </div>
              {declaration ? (
                <a
                  href={sourceHref(declaration.configPath)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline underline-offset-4"
                >
                  Open source ↗
                </a>
              ) : null}
            </div>
          ))}
          {routing?.status === "drift" ? (
            <>
              {routing.missingHosts.length > 0 || routing.unexpectedHosts.length > 0 ? (
                <div className="py-4">
                  <p className="font-mono text-xs">Domain</p>
                  <p className="mt-1.5 break-all text-xs text-muted-foreground">
                    <span className="text-destructive">Different routing</span> · declared{" "}
                    {routing.expectedHosts.join(", ") || "internal service"} · Dokploy has{" "}
                    {routing.observedHosts?.join(", ") || "none"}
                  </p>
                </div>
              ) : null}
              {routing.portMismatch ? (
                <div className="py-4">
                  <p className="font-mono text-xs">Container port</p>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    <span className="text-destructive">Different routing</span> · declared{" "}
                    {routing.declaredPort} · Dokploy has{" "}
                    {routing.observedPorts?.map((port) => port ?? "unknown").join(", ") || "none"}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : matched && routing?.status !== "unavailable" ? (
        <div className="flex items-center gap-3 py-4">
          <RiScales3Line aria-hidden="true" className="size-5 text-muted-foreground" />
          <p className="text-sm">No differences</p>
        </div>
      ) : null}
      {routing?.status === "drift" ? (
        <a
          href={sourceHref(routing.sourcePath)}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-xs underline underline-offset-4"
        >
          Open routing source ↗
        </a>
      ) : null}
      {routing?.status === "unavailable" || routing?.status === "not-declared" ? (
        <p className="text-xs text-muted-foreground">
          {routing.status === "unavailable"
            ? "Routing observations are unavailable or incomplete."
            : "No routing policy is declared for this service."}
        </p>
      ) : null}
      {(matched?.envFindings.some((finding) => finding.state === "build-arg-runtime-copy") ??
      false) ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Informational environment findings</summary>
          {matched?.envFindings
            .filter((finding) => finding.state === "build-arg-runtime-copy")
            .map((finding) => (
              <p className="py-2" key={finding.key}>
                <span className="font-mono">{finding.key}</span> · build argument copied to runtime
              </p>
            ))}
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Detection only · checks compare stored configuration. Values and credentials are not
        compared, and changes require source, Dokploy, or host-local apply commands.
      </p>
    </div>
  );
}
