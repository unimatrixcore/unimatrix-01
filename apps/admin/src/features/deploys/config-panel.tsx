import { RiBox3Line, RiFileCodeLine, RiKeyLine, RiSettings3Line } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import type { DeployDeclaration, DeployStateResponse } from "@unimatrix/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@unimatrix/ui/editor";
import type { ReactNode } from "react";

type EnvironmentSource = DeployDeclaration["env"][number]["source"];

function DeclarationRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 border-b border-border/50 py-2 text-sm last:border-0">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {label === "Image" ? (
          <RiBox3Line className="size-4 shrink-0" />
        ) : label === "Declared in" || label === "Generated into" ? (
          <RiFileCodeLine className="size-4 shrink-0" />
        ) : (
          <RiSettings3Line className="size-4 shrink-0" />
        )}
        {label}
      </span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

function SourceValue({ source }: { source: EnvironmentSource }) {
  switch (source.kind) {
    case "literal":
    case "generated":
      return <span title={source.value}>{source.value || '""'}</span>;
    case "variable":
      return (
        <span title={source.defaultValue}>
          {source.defaultValue === undefined ? "No default declared" : source.defaultValue || '""'}
        </span>
      );
    case "secrets-store":
      return (
        <Link to="/secrets" className="underline underline-offset-4" title={source.secretName}>
          {source.secretName}
        </Link>
      );
  }
}

function sourceDescription(source: EnvironmentSource): string {
  switch (source.kind) {
    case "literal":
      return "Committed literal";
    case "generated":
      return `Generated · ${source.name}`;
    case "variable":
      return `${source.bootstrap ? "Bootstrap · set by hand" : "Variable"} · ${source.name} · ${source.required ? "required" : "optional"}`;
    case "secrets-store":
      return `Secrets store · ${source.name} · required`;
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
    <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
      <TableHeader>
        <TableRow>
          <TableHead className="w-1/2" title="Name">
            Name
          </TableHead>
          <TableHead className="w-1/2" title="{valueLabel}">
            {valueLabel}
          </TableHead>
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ConfigPanel({
  declaration,
  service,
}: {
  declaration: DeployDeclaration;
  service?: DeployStateResponse["apps"][number];
}) {
  return (
    <div className="space-y-5">
      <div>
        <DeclarationRow label="Type">
          {declaration.kind === "static-spa" ? "Static site" : "Node service"}
        </DeclarationRow>
        <DeclarationRow label="Image">
          <span className="font-mono text-xs">{declaration.image}</span>
        </DeclarationRow>
        <DeclarationRow label="Domain">
          {service?.domains == null
            ? "Domain observation unavailable"
            : service.domains.length === 0
              ? "No routed domain"
              : service.domains.map((domain) => (
                  <a
                    className="mr-3 inline-flex text-sm underline underline-offset-4"
                    key={`${domain.host}${domain.path ?? ""}`}
                    href={`${domain.https ? "https" : "http"}://${domain.host}${domain.path ?? "/"}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {domain.host}
                    {domain.path} ↗
                  </a>
                ))}
        </DeclarationRow>
        <DeclarationRow label="Container port">{declaration.containerPort}</DeclarationRow>
        <DeclarationRow label="Declared in">
          <span className="font-mono text-xs">{declaration.configPath}</span>
        </DeclarationRow>
        <DeclarationRow label="Generated into">
          <span className="font-mono text-xs">{declaration.composePath}</span>
        </DeclarationRow>
        <DeclarationRow label="Health target">
          <span className="font-mono text-xs">{declaration.healthProbe.url}</span>
        </DeclarationRow>
        {declaration.healthProbe.caCertificateEnv === undefined ? null : (
          <DeclarationRow label="Probe CA source">
            <span className="font-mono text-xs">{declaration.healthProbe.caCertificateEnv}</span>
          </DeclarationRow>
        )}
        <DeclarationRow label="Public status">
          {declaration.publicStatus ? (
            <a
              href="https://status.unimatrix-01.dev"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              Listed on public status ↗
            </a>
          ) : (
            "Not listed"
          )}
        </DeclarationRow>
      </div>

      <section className="space-y-2" aria-label="Environment variables">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <RiKeyLine className="size-4 text-muted-foreground" aria-hidden="true" /> Environment
          variables
        </h3>
        {declaration.env.length === 0 ? (
          <p className="text-sm text-muted-foreground">No environment variables declared.</p>
        ) : (
          <Table className="table-fixed [&_th]:truncate [&_th]:text-xs [&_td]:truncate">
            <TableHeader>
              <TableRow>
                <TableHead className="w-1/2" title="Name and source">
                  Name and source
                </TableHead>
                <TableHead className="w-1/2" title="Declared value or source">
                  Declared value or source
                </TableHead>
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
                      className="block truncate text-muted-foreground"
                      title={sourceDescription(source)}
                    >
                      {sourceDescription(source)}
                    </span>
                  </TableCell>
                  <TableCell className="truncate font-mono text-xs text-muted-foreground">
                    <SourceValue source={source} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-2" aria-label="Build arguments">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <RiSettings3Line className="size-4 text-muted-foreground" aria-hidden="true" /> Build
          arguments
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
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <RiBox3Line className="size-4 text-muted-foreground" aria-hidden="true" /> Dockerfile
          environment defaults
        </h3>
        {declaration.dockerfileEnv.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Dockerfile environment defaults declared.
          </p>
        ) : (
          <DefaultsTable rows={declaration.dockerfileEnv} valueLabel="Declared default" />
        )}
      </section>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <RiFileCodeLine className="size-4 shrink-0" aria-hidden="true" />
        Defaults describe the declaration, not the inputs used to build or run the current image.
      </p>
    </div>
  );
}
