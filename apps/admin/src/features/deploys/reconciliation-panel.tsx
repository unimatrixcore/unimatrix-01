import { Link } from "@tanstack/react-router";
import { RiInformationLine } from "@remixicon/react";
import type { DeployReconciliationResponse, DeployDeclaration } from "@unimatrix/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@unimatrix/ui/editor";

const envStateLabels = {
  set: "Present · value equality not checked",
  blank: "Blank · needs resolution",
  missing: "Missing · needs resolution",
  "optional-absent": "Optional · absent",
  undeclared: "Undeclared · needs resolution",
  "build-arg-runtime-copy": "Informational · build argument copied to runtime",
} as const;

function timestamp(value: number | null): string {
  return value === null ? "Not scheduled" : new Date(value).toLocaleString();
}

export function ReconciliationPanel({
  snapshot,
  app,
  declaration,
}: {
  snapshot: DeployReconciliationResponse;
  app: string;
  declaration?: DeployDeclaration | undefined;
}) {
  const result = snapshot.results.find((entry) => entry.appDir === app);
  const diff = result?.outcome === "diffed" ? result.diff : undefined;
  const findings =
    diff?.verdict === "matched"
      ? diff.envFindings.filter(
          (finding) => finding.state !== "set" && finding.state !== "optional-absent",
        )
      : [];
  const title =
    snapshot.status === "not-checked"
      ? "Not checked"
      : snapshot.status === "checking"
        ? "Checking"
        : (snapshot.status === "read-failed" && result === undefined) || result?.outcome === "error"
          ? "Check unavailable"
          : diff === undefined
            ? "No result for this service"
            : diff.verdict === "missing"
              ? "Not created yet"
              : diff.verdict === "ambiguous"
                ? "Service mapping is ambiguous"
                : diff.inSync
                  ? "No detected drift"
                  : "Detected drift needs a decision";

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground">
          {snapshot.observedAt === null
            ? "No completed check"
            : `Checked ${timestamp(snapshot.observedAt)}`}{" "}
          · Next check: {timestamp(snapshot.nextRunAt)}
        </p>
        {snapshot.freshness === "stale" ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Stale snapshot — these findings may have changed.
          </p>
        ) : null}
      </div>

      {diff?.verdict === "ambiguous" ? (
        <p className="text-sm text-muted-foreground">
          {diff.matchCount} services matched this declaration. Resolve the service mapping before
          comparing configuration.
        </p>
      ) : null}
      {diff?.verdict === "missing" ? (
        <p className="text-sm text-muted-foreground">
          No Dokploy service matched this declaration.
        </p>
      ) : null}
      {diff?.verdict === "matched" ? (
        <>
          <section className="space-y-2" aria-label="Environment findings">
            <h3 className="text-sm font-medium">Environment</h3>
            {findings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No environment findings.</p>
            ) : (
              <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-2/5" title="Key">
                      Key
                    </TableHead>
                    <TableHead className="w-3/5" title="Finding">
                      Finding
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {findings.map((finding) => (
                    <TableRow key={finding.key}>
                      <TableCell className="truncate font-mono text-xs" title={finding.key}>
                        {finding.key}
                        <span
                          className="mt-1 block truncate text-muted-foreground"
                          title={declaration?.configPath}
                        >
                          {declaration?.env.find((entry) => entry.name === finding.key)?.source
                            .kind ?? "Undeclared"}
                        </span>
                      </TableCell>
                      <TableCell className="truncate text-xs" title={envStateLabels[finding.state]}>
                        {envStateLabels[finding.state]}
                        {declaration && finding.state !== "build-arg-runtime-copy" && (
                          <span className="mt-1 block">
                            {declaration.env.find((entry) => entry.name === finding.key)?.source
                              .kind === "secrets-store" ? (
                              <Link to="/secrets" className="underline underline-offset-4">
                                Open Secrets
                              </Link>
                            ) : (
                              <a
                                className="underline underline-offset-4"
                                target="_blank"
                                rel="noreferrer"
                                href={`https://github.com/unimatrixcore/unimatrix-01/blob/main/${declaration.configPath.split("/").map(encodeURIComponent).join("/")}`}
                              >
                                Open source ↗
                              </a>
                            )}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
          {diff.routing && (
            <section className="space-y-2" aria-label="Routing findings">
              <h3 className="text-sm font-medium">Routing</h3>
              {(diff.routing.status === "unavailable" ||
                diff.routing.status === "not-declared") && (
                <p className="text-xs text-amber-400">
                  {diff.routing.status === "unavailable"
                    ? "Routing observations are unavailable or incomplete. No routing sync claim can be made."
                    : "No routing policy is declared for this service."}
                </p>
              )}
              <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/4" title="Field">
                      Field
                    </TableHead>
                    <TableHead className="w-[37.5%]" title="Declared">
                      Declared
                    </TableHead>
                    <TableHead className="w-[37.5%]" title="Stored in Dokploy">
                      Stored in Dokploy
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="text-xs">Domains</TableCell>
                    <TableCell
                      className="truncate text-xs"
                      title={diff.routing.expectedHosts.join(", ")}
                    >
                      {diff.routing.expectedHosts.join(", ") ||
                        (diff.routing.status === "not-declared"
                          ? "Not declared"
                          : "Internal service")}
                    </TableCell>
                    <TableCell
                      className="truncate text-xs"
                      title={diff.routing.observedHosts?.join(", ")}
                    >
                      {diff.routing.observedHosts === null
                        ? "Unavailable"
                        : diff.routing.observedHosts.join(", ") || "No routed domains"}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell className="text-xs" title="Target port">
                      Target port
                    </TableCell>
                    <TableCell className="text-xs">{diff.routing.declaredPort}</TableCell>
                    <TableCell
                      className="truncate text-xs"
                      title={diff.routing.observedPorts
                        ?.map((port) => port ?? "Unknown")
                        .join(", ")}
                    >
                      {diff.routing.observedPorts === null
                        ? "Unavailable"
                        : diff.routing.observedPorts.map((port) => port ?? "Unknown").join(", ") ||
                          "No routed port"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <a
                className="text-xs underline underline-offset-4"
                target="_blank"
                rel="noreferrer"
                href={`https://github.com/unimatrixcore/unimatrix-01/blob/main/${diff.routing.sourcePath}`}
              >
                Routing policy ↗
              </a>
            </section>
          )}
          <section className="space-y-2" aria-label="Setting findings">
            <h3 className="text-sm font-medium">Settings</h3>
            {diff.settingFindings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No setting drift detected.</p>
            ) : (
              <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-1/3" title="Setting">
                      Setting
                    </TableHead>
                    <TableHead className="w-1/3" title="Declared">
                      Declared
                    </TableHead>
                    <TableHead className="w-1/3" title="Stored in Dokploy">
                      Stored in Dokploy
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {diff.settingFindings.map((finding) => (
                    <TableRow key={finding.setting}>
                      <TableCell className="truncate text-xs" title={finding.setting}>
                        {finding.setting}
                      </TableCell>
                      <TableCell className="truncate font-mono text-xs" title={finding.declared}>
                        {finding.declared}
                      </TableCell>
                      <TableCell className="truncate font-mono text-xs" title={finding.actual}>
                        {finding.actual}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      ) : null}
      <Alert>
        <RiInformationLine aria-hidden="true" />
        <AlertTitle>Detection only</AlertTitle>
        <AlertDescription>
          Checks compare Dokploy’s stored configuration with the declaration. They do not inspect
          runtime environment values or compare credentials with the secrets store. Resolve findings
          in the declaration, in Dokploy, or through the host-local settings and secrets apply
          commands. Refresh reads this snapshot without starting a check.
        </AlertDescription>
      </Alert>
    </div>
  );
}
