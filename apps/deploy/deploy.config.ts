import { internalServiceUrl, nodeApiApp } from "@unimatrix/deploy-config";

export default nodeApiApp({
  appDir: "deploy",
  healthProbe: { scheme: "https", caCertificateEnv: "DEPLOY_TLS_CERT_BASE64" },
  packageName: "@unimatrix/deploy-app",
  dockerfileEnv: [
    { name: "NODE_ENV", value: "production" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: "3001" },
    { name: "LOG_LEVEL", value: "info" },
    { name: "DEPLOY_DATABASE_PATH", value: "/data/deploy.sqlite" },
  ],
  composeEnv: [
    { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
    { name: "PORT", value: { kind: "literal", value: "3001" } },
    { name: "NODE_ENV", value: { kind: "literal", value: "production" } },
    { name: "LOG_LEVEL", value: { kind: "literal", value: "info" } },
    {
      name: "DOKPLOY_BASE_URL",
      value: { kind: "variable", name: "DOKPLOY_BASE_URL" },
      comment: [
        "This service's own Compose stack, reachable over dokploy-network — see",
        "that network's comment below. No default: an unset variable reaches the",
        "container as an empty string rather than as absent, and this service's",
        "config loader refuses an empty value, so a stack deployed before this is",
        "set stops the service instead of booting it against nothing.",
      ],
    },
    {
      name: "DOKPLOY_API_KEY",
      value: { kind: "variable", name: "DOKPLOY_API_KEY" },
      comment: [
        "Unscoped and unexpiring — it can delete every application on the",
        "instance. It comes only from this variable, never lands on",
        "runtimeConfig, and never appears in a log line or an error message.",
        "See apps/deploy/AGENTS.md.",
      ],
    },
    {
      name: "SECRETS_BASE_URL",
      value: { kind: "generated", name: "SECRETS_BASE_URL", value: internalServiceUrl("secrets") },
      comment: [
        "How the secrets-status CLI path reaches the store, over the shared",
        "unimatrix-secrets network declared below — same reasoning as",
        "apps/api/deploy.config.ts's entry of the same name. Read only: this",
        "service's read token is never declared here (see the network comment)",
        "and no code path can write through it.",
      ],
    },
    {
      name: "DEPLOY_TLS_CERT_BASE64",
      value: { kind: "variable", name: "DEPLOY_TLS_CERT_BASE64" },
      comment: [
        "Base64 PEM certificate and private key, provisioned before deployment.",
        "Production refuses to boot without both. The certificate SAN must",
        "include deploy, the Compose DNS name used by pinned HTTPS clients.",
        "Keep the private key out of images and caller configuration.",
      ],
    },
    { name: "DEPLOY_TLS_KEY_BASE64", value: { kind: "variable", name: "DEPLOY_TLS_KEY_BASE64" } },
    {
      name: "SECRETS_TLS_CERT_BASE64",
      value: { kind: "variable", name: "SECRETS_TLS_CERT_BASE64" },
      comment: [
        "The store's certificate only, never its key — supplying it replaces",
        "this service's trust store for connections to the secrets store",
        "rather than widening it. The health probe also uses this pin; missing",
        "or invalid trust configuration produces unknown health.",
      ],
    },
  ],
  volumes: [{ name: "deploy-data", mountPath: "/data" }],
  networks: [
    {
      name: "dokploy-network",
      external: true,
      comment: [
        "This service exists to talk to Dokploy's own API, and the alternative —",
        "reaching https://dokploy.unimatrix-01.dev — costs two more Cloudflare",
        "Access service-token secrets and a round trip out through Cloudflare and",
        "back. The cost of joining: a container holding an instance-wide",
        "delete-everything token sits on the same network every app Traefik",
        "serves. No domain or Traefik entry routes public traffic here; network",
        "peers can reach it, so every request except GET /health requires a",
        "deploy service token over TLS. It is an attachable",
        "swarm overlay, which is what lets a plain Compose stack join it",
        "(measured on the host, 2026-08-12, recorded in apps/api/deploy.config.ts).",
      ],
    },
    {
      name: "unimatrix-secrets",
      external: true,
      comment: [
        "Create it on the host before the first deploy:",
        "`docker network create unimatrix-secrets`. The cost of joining, stated",
        "the same way apps/secrets/deploy.config.ts states the cost of the",
        "network above: the container already holding an instance-wide,",
        "delete-everything Dokploy token now also sits on the network carrying",
        "every secrets-store read for this instance. https:// is what encrypts",
        "that traffic; the certificate pin (SECRETS_TLS_CERT_BASE64) is what",
        "decides which server is allowed to answer, by replacing the trust store",
        "for this client rather than widening it. Network membership provides",
        "neither.",
      ],
    },
  ],
  healthcheckScheme: "https",
});
