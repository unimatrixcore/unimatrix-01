import {
  RiBox3Line,
  RiExternalLinkLine,
  RiFileCodeLine,
  RiFileCopyLine,
  RiGlobalLine,
  RiKeyLine,
  RiPlugLine,
  RiPulseLine,
  RiServerLine,
  RiSettings3Line,
} from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type {
  DeployDeclaration,
  DeployReconciliationResponse,
  DeployStateResponse,
} from "@unimatrix/shared";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@unimatrix/ui/editor";
import type { ReactNode } from "react";

type EnvironmentSource = DeployDeclaration["env"][number]["source"];
const rowIcons = {
  Type: RiServerLine,
  Image: RiBox3Line,
  Domain: RiGlobalLine,
  "Container port": RiPlugLine,
  "Declared in": RiFileCodeLine,
  "Generated into": RiFileCopyLine,
  "Health path": RiPulseLine,
};

export function DeclarationRow({ label, children }: { label: string; children: ReactNode }) {
  const Icon = rowIcons[label as keyof typeof rowIcons];
  return (
    <div className="flex gap-4 border-b border-border/40 py-2 last:border-b-0">
      <span className="flex w-36 shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-primary"
    >
      {children}
      <RiExternalLinkLine aria-hidden="true" className="size-3.5" />
    </a>
  );
}

function sourceValue(source: EnvironmentSource): string {
  switch (source.kind) {
    case "literal":
    case "generated":
      return source.value || '""';
    case "variable":
      return source.defaultValue === undefined
        ? "No default declared"
        : source.defaultValue || '""';
    case "secrets-store":
      return source.secretName;
  }
}
function sourceDescription(source: EnvironmentSource): string {
  switch (source.kind) {
    case "literal":
      return "config literal";
    case "generated":
      return "generated";
    case "variable":
      return `${source.bootstrap ? "set by hand" : "variable"}${source.required ? "" : " · optional"}`;
    case "secrets-store":
      return "secrets store";
  }
}
function DefaultsTable({
  rows,
  valueLabel,
}: {
  rows: readonly { name: string; value: string | undefined }[];
  valueLabel: string;
}) {
  return (
    <Table className="table-fixed [&_th]:truncate [&_td]:truncate">
      <TableHeader>
        <TableRow>
          <TableHead className="w-72">Name</TableHead>
          <TableHead title={valueLabel}>{valueLabel}</TableHead>
          <TableHead className="w-40 text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.name}>
            <TableCell className="truncate font-mono text-xs" title={row.name}>
              {row.name}
            </TableCell>
            <TableCell
              className="truncate font-mono text-xs text-muted-foreground"
              title={row.value}
            >
              {row.value === undefined ? "No default declared" : row.value || '""'}
            </TableCell>
            <TableCell />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ConfigPanel({
  declaration,
  service,
  reconciliation,
}: {
  declaration: DeployDeclaration;
  service?: DeployStateResponse["apps"][number];
  reconciliation?: DeployReconciliationResponse;
}) {
  const result = reconciliation?.results.find((entry) => entry.appDir === declaration.appDir);
  const routing =
    result?.outcome === "diffed" && result.diff.verdict === "matched"
      ? result.diff.routing
      : undefined;
  const hosts =
    routing && routing.status !== "not-declared"
      ? routing.expectedHosts
      : service?.domains?.map((domain) => domain.host);
  return (
    <div className="space-y-5">
      <div>
        <DeclarationRow label="Type">
          {declaration.kind === "static-spa" ? "Static site" : "Node service"}
        </DeclarationRow>
        <DeclarationRow label="Image">
          <span className="break-all font-mono text-xs">{declaration.image}</span>
        </DeclarationRow>
        <DeclarationRow label="Domain">
          {hosts === undefined ? (
            <span className="text-muted-foreground">Domain observation unavailable</span>
          ) : hosts.length === 0 ? (
            <span className="text-muted-foreground">internal only — no domain</span>
          ) : (
            hosts.map((host) => (
              <span key={host} className="mr-3">
                <ExternalLink href={`https://${host}`}>{host}</ExternalLink>
              </span>
            ))
          )}
          {routing?.status === "drift" &&
          (routing.missingHosts.length > 0 || routing.unexpectedHosts.length > 0) ? (
            <span className="text-destructive">
              {" "}
              · Dokploy has {routing.observedHosts?.join(", ") || "none"}
            </span>
          ) : null}
        </DeclarationRow>
        <DeclarationRow label="Container port">
          <span className="font-mono text-xs">{declaration.containerPort}</span>
          {routing?.portMismatch ? (
            <span className="text-destructive">
              {" "}
              · Dokploy has{" "}
              {routing.observedPorts?.map((port) => port ?? "unknown").join(", ") || "none"}
            </span>
          ) : null}
        </DeclarationRow>
        <DeclarationRow label="Declared in">
          <span className="break-all font-mono text-xs">{declaration.configPath}</span>
        </DeclarationRow>
        <DeclarationRow label="Generated into">
          <span className="break-all font-mono text-xs">{declaration.composePath}</span>
        </DeclarationRow>
        <DeclarationRow label="Health path">
          <span className="break-all font-mono text-xs" title={declaration.healthProbe.url}>
            {new URL(declaration.healthProbe.url).pathname}
          </span>
        </DeclarationRow>
        {declaration.healthProbe.caCertificateEnv ? (
          <DeclarationRow label="Probe CA source">
            <span className="break-all font-mono text-xs">
              {declaration.healthProbe.caCertificateEnv}
            </span>
          </DeclarationRow>
        ) : null}
        <DeclarationRow label="Public status">
          {declaration.publicStatus ? (
            <ExternalLink href="https://status.unimatrix-01.dev">
              Listed on public status
            </ExternalLink>
          ) : (
            <span className="text-muted-foreground">Not listed</span>
          )}
        </DeclarationRow>
      </div>
      <section className="space-y-2" aria-label="Environment variables">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RiKeyLine className="size-4 text-muted-foreground" aria-hidden="true" />
          Environment variables
        </h3>
        {declaration.env.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No environment variables declared — add them in{" "}
            <span className="font-mono text-xs">{declaration.configPath}</span>.
          </p>
        ) : (
          <Table className="table-fixed [&_th]:truncate [&_td]:truncate">
            <TableHeader>
              <TableRow>
                <TableHead className="w-72">Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-40 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {declaration.env.map(({ name, source }) => (
                <TableRow key={name}>
                  <TableCell className="text-xs">
                    <span className="block truncate font-mono" title={name}>
                      {name}
                    </span>
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={sourceDescription(source)}
                    >
                      {sourceDescription(source)}
                    </span>
                  </TableCell>
                  <TableCell className="truncate text-xs">
                    <span
                      className="block truncate font-mono text-muted-foreground"
                      title={sourceValue(source)}
                    >
                      {sourceValue(source)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {source.kind === "secrets-store" ? (
                      <Button variant="link" className="h-auto px-0 text-xs" asChild>
                        <Link to="/secrets">
                          <RiKeyLine aria-hidden="true" className="size-3.5" />
                          Open in Secrets
                        </Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="space-y-2" aria-label="Build arguments">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RiSettings3Line className="size-4 text-muted-foreground" aria-hidden="true" />
          Build arguments
        </h3>
        {declaration.buildArgs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No build arguments declared.</p>
        ) : (
          <DefaultsTable
            rows={declaration.buildArgs.map((entry) => ({
              name: entry.name,
              value: entry.defaultValue,
            }))}
            valueLabel="Declared default"
          />
        )}
      </section>
      <section className="space-y-2" aria-label="Dockerfile environment defaults">
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RiBox3Line className="size-4 text-muted-foreground" aria-hidden="true" />
          Dockerfile environment defaults
        </h3>
        {declaration.dockerfileEnv.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Dockerfile environment defaults declared.
          </p>
        ) : (
          <DefaultsTable rows={declaration.dockerfileEnv} valueLabel="Declared default" />
        )}
      </section>
    </div>
  );
}
