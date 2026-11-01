import type { DeployDesiredService } from "@unimatrix/deploy-config";
import type { DokployCompose } from "../dokploy/schemas.js";

export const ROUTING_POLICY_PATH = "apps/deploy/src/reconcile/routing-policy.ts";

export const DEPLOY_ROUTING_HOSTS: Readonly<Record<string, readonly string[]>> = {
  admin: ["admin.unimatrix-01.dev"],
  api: ["api.unimatrix-01.dev"],
  auth: ["auth.unimatrix-01.dev"],
  cflop: ["cflop.unimatrix-01.dev", "cube.unimatrix-01.dev"],
  deploy: [],
  secrets: [],
  status: ["status.unimatrix-01.dev"],
  web: ["unimatrix-01.dev"],
};

export interface RoutingComparison {
  readonly sourcePath: typeof ROUTING_POLICY_PATH;
  readonly status: "in-sync" | "drift" | "unavailable" | "not-declared";
  readonly expectedHosts: readonly string[];
  readonly observedHosts: readonly string[] | null;
  readonly missingHosts: readonly string[];
  readonly unexpectedHosts: readonly string[];
  readonly declaredPort: number;
  readonly observedPorts: readonly (number | null)[] | null;
  readonly portMismatch: boolean;
}

export function compareRouting(
  service: Pick<DeployDesiredService, "appDir" | "containerPort">,
  domains: DokployCompose["domains"],
): RoutingComparison {
  const expected = DEPLOY_ROUTING_HOSTS[service.appDir];
  const expectedHosts = [...(expected ?? [])].sort();
  const observedHosts =
    domains == null
      ? null
      : [...new Set(domains.map((domain) => domain.host.toLowerCase()))].sort();
  const observedPorts = domains == null ? null : domains.map((domain) => domain.port);
  const missingHosts =
    expected === undefined || observedHosts === null
      ? []
      : expectedHosts.filter((host) => !observedHosts.includes(host));
  const unexpectedHosts =
    expected === undefined || observedHosts === null
      ? []
      : observedHosts.filter((host) => !expectedHosts.includes(host));
  const portMismatch =
    expected !== undefined &&
    (observedPorts?.some((port) => port !== null && port !== service.containerPort) ?? false);
  const drift = missingHosts.length > 0 || unexpectedHosts.length > 0 || portMismatch;
  const status =
    expected === undefined
      ? "not-declared"
      : observedHosts === null
        ? "unavailable"
        : drift
          ? "drift"
          : observedPorts?.some((port) => port === null)
            ? "unavailable"
            : "in-sync";
  return {
    sourcePath: ROUTING_POLICY_PATH,
    status,
    expectedHosts,
    observedHosts,
    missingHosts,
    unexpectedHosts,
    declaredPort: service.containerPort,
    observedPorts,
    portMismatch,
  };
}
