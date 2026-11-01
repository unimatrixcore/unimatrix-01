import { nodeApiApp } from "@unimatrix/deploy-config";

export default nodeApiApp({
  appDir: "secrets",
  healthProbe: { scheme: "https", caCertificateEnv: "SECRETS_TLS_CERT_BASE64" },
  packageName: "@unimatrix/secrets-app",
  dockerfileEnv: [
    { name: "NODE_ENV", value: "production" },
    { name: "HOST", value: "0.0.0.0" },
    { name: "PORT", value: "3001" },
    { name: "LOG_LEVEL", value: "info" },
    {
      name: "SECRETS_DATABASE_URL",
      value: "/data/secrets.sqlite",
      comment: [
        "Sealed secret versions, service tokens and the audit log live under",
        "/data so they survive a redeploy — without a durable volume this",
        "store loses everything it exists to keep. Set DB_MIGRATE_ON_START=true",
        "(see secrets-compose.yaml) so pending migrations are applied against",
        "that volume at boot.",
      ],
    },
  ],
  composeEnv: [
    { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
    { name: "PORT", value: { kind: "literal", value: "3001" } },
    { name: "NODE_ENV", value: { kind: "literal", value: "production" } },
    { name: "LOG_LEVEL", value: { kind: "literal", value: "info" } },
    {
      name: "SECRETS_KEKS",
      value: { kind: "variable", name: "SECRETS_KEKS", bootstrap: true },
      comment: [
        "`<version>:<base64key>[,<version>:<base64key>...]`. Compose passes",
        "nothing to a container that is not named here — the API's CLERK_*",
        "restart loop is the recorded precedent for what leaving this out",
        "looks like from outside: a service that never boots, with nothing",
        "saying why. This key sits below every value this service stores in",
        "the trust order, so it must never itself be stored in this store.",
      ],
    },
    {
      name: "SECRETS_TLS_CERT_BASE64",
      value: { kind: "variable", name: "SECRETS_TLS_CERT_BASE64" },
      comment: [
        "The server certificate and its key, each a base64-encoded PEM (the",
        "platform's env editor is a single-line field). Generated once on the",
        "host, never in the image and never at boot: an image layer would ship",
        "the private key to the registry, and a fresh key per restart would",
        "invalidate the API's pinned copy within minutes. The certificate's SAN",
        "must be this Compose service name — `secrets` — because that is the",
        "host the API connects to and hostname verification stays on.",
        "",
        "All-or-none: set both or neither. Set exactly one, or leave one empty,",
        "and this service refuses to boot rather than quietly serving cleartext",
        "on a port the API now expects TLS on.",
      ],
    },
    {
      name: "SECRETS_TLS_KEY_BASE64",
      value: { kind: "variable", name: "SECRETS_TLS_KEY_BASE64", bootstrap: true },
    },
    {
      name: "DB_MIGRATE_ON_START",
      value: { kind: "literal", value: '"true"' },
      comment: [
        "Apply pending Drizzle migrations against the mounted volume at",
        "startup (idempotent). The DB file defaults to /data/secrets.sqlite",
        "(set in the Dockerfile); the secrets-data volume below persists it",
        "across redeploys.",
      ],
    },
  ],
  volumes: [{ name: "secrets-data", mountPath: "/data" }],
  networks: [
    {
      name: "unimatrix-secrets",
      external: true,
      aliases: ["secrets"],
      comment: [
        "Create it on the host before the first deploy — an external network",
        "must already exist: `docker network create unimatrix-secrets`. A plain",
        "bridge; both stacks are Compose on one host, so an overlay buys",
        "nothing.",
        "",
        "Deliberately not dokploy-network: every container there is one Traefik",
        "serves, so joining it would put this store within reach of every app",
        "on the host. This service has no domain and needs no Traefik route.",
      ],
    },
  ],
  // Whether this service serves TLS is decided by its environment, not by its
  // image, so the probe reads the same variable the config loader does. A
  // hardcoded https probe would mark a deliberately plain-HTTP deployment
  // unhealthy forever while it served traffic fine.
  healthcheckScheme: { kind: "variable", name: "SECRETS_TLS_CERT_BASE64" },
});
