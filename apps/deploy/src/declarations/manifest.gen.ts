// GENERATED — edit the relevant apps/<app>/deploy.config.ts and run
// `node ./infra/scripts/generate-deploy-config.mjs`, not this file.
import type { DeployDeclaration } from "@unimatrix/deploy-config";

export const DEPLOY_DECLARATIONS: readonly DeployDeclaration[] = [
  {
    appDir: "admin",
    packageName: "@unimatrix/admin",
    kind: "static-spa",
    configPath: "apps/admin/deploy.config.ts",
    composePath: "infra/docker/admin-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-admin",
    containerPort: 8080,
    publicStatus: false,
    healthProbe: {
      url: "http://admin:8080/",
    },
    env: [
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
    ],
    dockerfileEnv: [],
    buildArgs: [
      {
        name: "VITE_API_BASE_URL",
        defaultValue: "https://api.unimatrix-01.dev",
      },
      {
        name: "VITE_AUTH_APP_URL",
        defaultValue: "https://auth.unimatrix-01.dev",
      },
      {
        name: "VITE_CLERK_PUBLISHABLE_KEY",
        defaultValue: "pk_live_Y2xlcmsudW5pbWF0cml4LTAxLmRldiQ",
      },
    ],
  },
  {
    appDir: "api",
    packageName: "@unimatrix/api",
    kind: "node-api",
    configPath: "apps/api/deploy.config.ts",
    composePath: "infra/docker/api-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-api",
    containerPort: 3001,
    publicStatus: true,
    healthProbe: {
      url: "http://api:3001/health",
    },
    env: [
      {
        name: "CLERK_JWT_KEY",
        source: {
          kind: "secrets-store",
          name: "CLERK_JWT_KEY",
          secretName: "platform/clerk-jwt-key",
          required: true,
        },
      },
      {
        name: "CLERK_PUBLISHABLE_KEY",
        source: {
          kind: "secrets-store",
          name: "CLERK_PUBLISHABLE_KEY",
          secretName: "platform/clerk-publishable-key",
          required: true,
        },
      },
      {
        name: "CLERK_SECRET_KEY",
        source: {
          kind: "secrets-store",
          name: "CLERK_SECRET_KEY",
          secretName: "platform/clerk-secret-key",
          required: true,
        },
      },
      {
        name: "CORS_ALLOWED_ORIGINS",
        source: {
          kind: "variable",
          name: "CORS_ALLOWED_ORIGINS",
          required: true,
        },
      },
      {
        name: "DB_MIGRATE_ON_START",
        source: {
          kind: "literal",
          value: '"true"',
        },
      },
      {
        name: "DEPLOY_BASE_URL",
        source: {
          kind: "generated",
          name: "DEPLOY_BASE_URL",
          value: "https://deploy:3001",
        },
      },
      {
        name: "DEPLOY_SERVICE_TOKEN",
        source: {
          kind: "variable",
          name: "DEPLOY_SERVICE_TOKEN",
          required: true,
        },
      },
      {
        name: "DEPLOY_TLS_CERT_BASE64",
        source: {
          kind: "variable",
          name: "DEPLOY_TLS_CERT_BASE64",
          required: true,
        },
      },
      {
        name: "HOST",
        source: {
          kind: "literal",
          value: "0.0.0.0",
        },
      },
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
      {
        name: "LOG_LEVEL",
        source: {
          kind: "literal",
          value: "info",
        },
      },
      {
        name: "NODE_ENV",
        source: {
          kind: "literal",
          value: "production",
        },
      },
      {
        name: "PORT",
        source: {
          kind: "literal",
          value: "3001",
        },
      },
      {
        name: "SECRETS_BASE_URL",
        source: {
          kind: "generated",
          name: "SECRETS_BASE_URL",
          value: "https://secrets:3001",
        },
      },
      {
        name: "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
        source: {
          kind: "variable",
          name: "SECRETS_INTEGRATIONS_MANAGE_TOKEN",
          required: true,
        },
      },
      {
        name: "SECRETS_PLATFORM_WRITE_TOKEN",
        source: {
          kind: "variable",
          name: "SECRETS_PLATFORM_WRITE_TOKEN",
          required: true,
        },
      },
      {
        name: "SECRETS_SERVICE_TOKEN",
        source: {
          kind: "variable",
          name: "SECRETS_SERVICE_TOKEN",
          required: true,
        },
      },
      {
        name: "SECRETS_TLS_CERT_BASE64",
        source: {
          kind: "variable",
          name: "SECRETS_TLS_CERT_BASE64",
          required: true,
        },
      },
      {
        name: "TRUST_PROXY",
        source: {
          kind: "literal",
          value: '"10.0.1.166"',
        },
      },
    ],
    dockerfileEnv: [
      {
        name: "DATABASE_URL",
        value: "/data/unimatrix.sqlite",
      },
      {
        name: "HOST",
        value: "0.0.0.0",
      },
      {
        name: "LOG_LEVEL",
        value: "info",
      },
      {
        name: "NODE_ENV",
        value: "production",
      },
      {
        name: "PORT",
        value: "3001",
      },
    ],
    buildArgs: [],
  },
  {
    appDir: "auth",
    packageName: "@unimatrix/auth-app",
    kind: "static-spa",
    configPath: "apps/auth/deploy.config.ts",
    composePath: "infra/docker/auth-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-auth",
    containerPort: 8080,
    publicStatus: false,
    healthProbe: {
      url: "http://auth:8080/",
    },
    env: [
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
    ],
    dockerfileEnv: [],
    buildArgs: [
      {
        name: "VITE_API_BASE_URL",
        defaultValue: "https://api.unimatrix-01.dev",
      },
      {
        name: "VITE_CLERK_PUBLISHABLE_KEY",
        defaultValue: "pk_live_Y2xlcmsudW5pbWF0cml4LTAxLmRldiQ",
      },
    ],
  },
  {
    appDir: "cflop",
    packageName: "@unimatrix/cflop",
    kind: "static-spa",
    configPath: "apps/cflop/deploy.config.ts",
    composePath: "infra/docker/cflop-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-cflop",
    containerPort: 8080,
    publicStatus: true,
    healthProbe: {
      url: "http://cflop:8080/",
    },
    env: [
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
    ],
    dockerfileEnv: [],
    buildArgs: [],
  },
  {
    appDir: "deploy",
    packageName: "@unimatrix/deploy-app",
    kind: "node-api",
    configPath: "apps/deploy/deploy.config.ts",
    composePath: "infra/docker/deploy-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-deploy",
    containerPort: 3001,
    publicStatus: false,
    healthProbe: {
      url: "https://deploy:3001/health",
      caCertificateEnv: "DEPLOY_TLS_CERT_BASE64",
    },
    env: [
      {
        name: "DEPLOY_TLS_CERT_BASE64",
        source: {
          kind: "variable",
          name: "DEPLOY_TLS_CERT_BASE64",
          required: true,
        },
      },
      {
        name: "DEPLOY_TLS_KEY_BASE64",
        source: {
          kind: "variable",
          name: "DEPLOY_TLS_KEY_BASE64",
          required: true,
          bootstrap: true,
        },
      },
      {
        name: "DOKPLOY_API_KEY",
        source: {
          kind: "variable",
          name: "DOKPLOY_API_KEY",
          required: true,
          bootstrap: true,
        },
      },
      {
        name: "DOKPLOY_BASE_URL",
        source: {
          kind: "variable",
          name: "DOKPLOY_BASE_URL",
          required: true,
        },
      },
      {
        name: "DOKPLOY_PUBLIC_URL",
        source: {
          kind: "literal",
          value: "https://dokploy.unimatrix-01.dev",
        },
      },
      {
        name: "HOST",
        source: {
          kind: "literal",
          value: "0.0.0.0",
        },
      },
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
      {
        name: "LOG_LEVEL",
        source: {
          kind: "literal",
          value: "info",
        },
      },
      {
        name: "NODE_ENV",
        source: {
          kind: "literal",
          value: "production",
        },
      },
      {
        name: "PORT",
        source: {
          kind: "literal",
          value: "3001",
        },
      },
      {
        name: "SECRETS_BASE_URL",
        source: {
          kind: "generated",
          name: "SECRETS_BASE_URL",
          value: "https://secrets:3001",
        },
      },
      {
        name: "SECRETS_TLS_CERT_BASE64",
        source: {
          kind: "variable",
          name: "SECRETS_TLS_CERT_BASE64",
          required: true,
        },
      },
    ],
    dockerfileEnv: [
      {
        name: "DEPLOY_DATABASE_PATH",
        value: "/data/deploy.sqlite",
      },
      {
        name: "HOST",
        value: "0.0.0.0",
      },
      {
        name: "LOG_LEVEL",
        value: "info",
      },
      {
        name: "NODE_ENV",
        value: "production",
      },
      {
        name: "PORT",
        value: "3001",
      },
    ],
    buildArgs: [],
  },
  {
    appDir: "secrets",
    packageName: "@unimatrix/secrets-app",
    kind: "node-api",
    configPath: "apps/secrets/deploy.config.ts",
    composePath: "infra/docker/secrets-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-secrets",
    containerPort: 3001,
    publicStatus: false,
    healthProbe: {
      url: "https://secrets:3001/health",
      caCertificateEnv: "SECRETS_TLS_CERT_BASE64",
    },
    env: [
      {
        name: "DB_MIGRATE_ON_START",
        source: {
          kind: "literal",
          value: '"true"',
        },
      },
      {
        name: "HOST",
        source: {
          kind: "literal",
          value: "0.0.0.0",
        },
      },
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
      {
        name: "LOG_LEVEL",
        source: {
          kind: "literal",
          value: "info",
        },
      },
      {
        name: "NODE_ENV",
        source: {
          kind: "literal",
          value: "production",
        },
      },
      {
        name: "PORT",
        source: {
          kind: "literal",
          value: "3001",
        },
      },
      {
        name: "SECRETS_KEKS",
        source: {
          kind: "variable",
          name: "SECRETS_KEKS",
          required: true,
          bootstrap: true,
        },
      },
      {
        name: "SECRETS_TLS_CERT_BASE64",
        source: {
          kind: "variable",
          name: "SECRETS_TLS_CERT_BASE64",
          required: true,
        },
      },
      {
        name: "SECRETS_TLS_KEY_BASE64",
        source: {
          kind: "variable",
          name: "SECRETS_TLS_KEY_BASE64",
          required: true,
          bootstrap: true,
        },
      },
    ],
    dockerfileEnv: [
      {
        name: "HOST",
        value: "0.0.0.0",
      },
      {
        name: "LOG_LEVEL",
        value: "info",
      },
      {
        name: "NODE_ENV",
        value: "production",
      },
      {
        name: "PORT",
        value: "3001",
      },
      {
        name: "SECRETS_DATABASE_URL",
        value: "/data/secrets.sqlite",
      },
    ],
    buildArgs: [],
  },
  {
    appDir: "status",
    packageName: "@unimatrix/status",
    kind: "static-spa",
    configPath: "apps/status/deploy.config.ts",
    composePath: "infra/docker/status-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-status",
    containerPort: 8080,
    publicStatus: false,
    healthProbe: {
      url: "http://status:8080/",
    },
    env: [
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
    ],
    dockerfileEnv: [],
    buildArgs: [
      {
        name: "VITE_API_BASE_URL",
        defaultValue: "https://api.unimatrix-01.dev",
      },
    ],
  },
  {
    appDir: "web",
    packageName: "@unimatrix/web",
    kind: "static-spa",
    configPath: "apps/web/deploy.config.ts",
    composePath: "infra/docker/web-compose.yaml",
    image: "ghcr.io/unimatrixcore/unimatrix-web",
    containerPort: 8080,
    publicStatus: true,
    healthProbe: {
      url: "http://web:8080/",
    },
    env: [
      {
        name: "IMAGE_TAG",
        source: {
          kind: "variable",
          name: "IMAGE_TAG",
          required: true,
        },
      },
    ],
    dockerfileEnv: [],
    buildArgs: [
      {
        name: "VITE_API_BASE_URL",
        defaultValue: "https://api.unimatrix-01.dev",
      },
    ],
  },
];
