import { internalServiceUrl, nodeApiApp } from "@unimatrix/deploy-config";
import {
  CLERK_JWT_KEY_SECRET,
  CLERK_PUBLISHABLE_KEY_SECRET,
  CLERK_SECRET_KEY_SECRET,
} from "@unimatrix/shared/secrets-registry";

export default nodeApiApp({
  appDir: "api",
  packageName: "@unimatrix/api",
  publicStatus: true,
  dockerfileEnv: [
    { name: "NODE_ENV", value: "production" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: "3001" },
    { name: "LOG_LEVEL", value: "info" },
    {
      name: "DATABASE_URL",
      value: "/data/unimatrix.sqlite",
      comment: [
        "The SQLite database (user settings + files) lives under /data so it can be",
        "backed by a persistent volume — without one, all user data is lost on",
        "redeploy. Set DB_MIGRATE_ON_START=true (see api-compose.yaml) so pending",
        "migrations are applied against that volume at boot.",
      ],
    },
  ],
  composeEnv: [
    {
      name: "DEPLOY_BASE_URL",
      value: { kind: "generated", name: "DEPLOY_BASE_URL", value: internalServiceUrl("deploy") },
    },
    { name: "DEPLOY_SERVICE_TOKEN", value: { kind: "variable", name: "DEPLOY_SERVICE_TOKEN" } },
    { name: "DEPLOY_TLS_CERT_BASE64", value: { kind: "variable", name: "DEPLOY_TLS_CERT_BASE64" } },
    { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
    { name: "PORT", value: { kind: "literal", value: "3001" } },
    { name: "NODE_ENV", value: { kind: "literal", value: "production" } },
    { name: "LOG_LEVEL", value: { kind: "literal", value: "info" } },
    {
      name: "TRUST_PROXY",
      value: { kind: "literal", value: '"10.0.1.166"' },
      comment: [
        "Trust only the immediate Traefik endpoint, not every app on dokploy-network.",
        "Revalidate this address after proxy recreation; see docs/deployment.md.",
      ],
    },
    {
      name: "CORS_ALLOWED_ORIGINS",
      value: { kind: "variable", name: "CORS_ALLOWED_ORIGINS" },
      comment: [
        "This and the three CLERK_* references below are bare, with no default,",
        "on purpose. An unset variable reaches the container as an empty string,",
        "not as absent, and this API's loader refuses an empty value — so a stack",
        "deployed before its values exist restart-loops, which reads from outside",
        "as every content route 404ing. Set all four in the deployment platform",
        "before deploying this stack.",
      ],
    },
    {
      name: "CLERK_SECRET_KEY",
      value: { kind: "secrets-store", name: "CLERK_SECRET_KEY", secret: CLERK_SECRET_KEY_SECRET },
      comment: [
        "Required together in production — the API refuses to boot without all",
        "three (`parseClerkConfig` in apps/api/src/config.ts). Compose passes",
        "nothing to a container that is not named here, so setting them in the",
        "deployment platform is not enough on its own: leaving this block out is",
        "what put the production API in a restart loop, which reads from outside",
        "as every content route 404ing.",
      ],
    },
    {
      name: "CLERK_PUBLISHABLE_KEY",
      value: {
        kind: "secrets-store",
        name: "CLERK_PUBLISHABLE_KEY",
        secret: CLERK_PUBLISHABLE_KEY_SECRET,
      },
    },
    {
      name: "CLERK_JWT_KEY",
      value: { kind: "secrets-store", name: "CLERK_JWT_KEY", secret: CLERK_JWT_KEY_SECRET },
      comment: [
        "A PEM public key. Clerk strips newlines before use, so a single-line",
        "value works and avoids a multi-line env value the platform may truncate.",
      ],
    },
    {
      name: "SECRETS_BASE_URL",
      value: { kind: "generated", name: "SECRETS_BASE_URL", value: internalServiceUrl("secrets") },
      comment: [
        "How this API reaches the secrets store, over the shared",
        "unimatrix-secrets network declared below. The host must be the store's",
        "Compose service name — that name is the SAN on its certificate, and",
        "hostname verification is on.",
        "",
        "Generated rather than set in the deployment platform: both halves are",
        "already declared here. The host is the store's own appDir, and the port",
        "is the shared node-api container port every service is generated",
        "against, so a hand-typed value could only ever agree with them or be",
        "wrong.",
      ],
    },
    { name: "SECRETS_SERVICE_TOKEN", value: { kind: "variable", name: "SECRETS_SERVICE_TOKEN" } },
    {
      name: "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
      value: { kind: "variable", name: "SECRETS_INTEGRATIONS_MANAGE_TOKEN" },
      comment: [
        "One scoped token per tier, and no two of the three may hold the same",
        "value — the store answers a wrong-capability caller with the same 404",
        "it uses for a missing name, so a shared token boots cleanly and then",
        "reports every call it cannot make as a credential that is not set.",
      ],
    },
    {
      name: "SECRETS_PLATFORM_WRITE_TOKEN",
      value: { kind: "variable", name: "SECRETS_PLATFORM_WRITE_TOKEN" },
    },
    {
      name: "SECRETS_TLS_CERT_BASE64",
      value: { kind: "variable", name: "SECRETS_TLS_CERT_BASE64" },
      comment: [
        "The store's certificate — the same base64 PEM its own stack carries,",
        "and only that one. The private key belongs to the store alone and must",
        "never appear here. Supplying the certificate pins it: it replaces the",
        "system trust store for these connections rather than widening it.",
      ],
    },
    {
      name: "DB_MIGRATE_ON_START",
      value: { kind: "literal", value: '"true"' },
      comment: [
        "Apply pending Drizzle migrations against the mounted volume at startup",
        "(idempotent). The DB file defaults to /data/unimatrix.sqlite (set in the",
        "Dockerfile); the api-data volume below persists it across redeploys.",
      ],
    },
  ],
  volumes: [{ name: "api-data", mountPath: "/data" }],
  networks: [
    {
      name: "unimatrix-secrets",
      external: true,
      comment: [
        "Create it on the host before the first deploy:",
        "`docker network create unimatrix-secrets`.",
      ],
    },
    {
      name: "dokploy-network",
      external: true,
      comment: [
        "Declared explicitly because naming any network at all drops the",
        "implicit default, and Dokploy attaches this one from outside the",
        "compose file so that attachment cannot be relied on to survive. Without",
        "it Traefik loses its route to this service and the public API answers",
        "502. It is an attachable swarm overlay, which is what lets a plain",
        "Compose stack join it (measured on the host, 2026-08-12).",
      ],
    },
  ],
});
