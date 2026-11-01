import { describe, expect, it } from "vitest";

import {
  composeFor,
  deployDeclarationsModule,
  deployDesiredStateModule,
  dockerfileFor,
  type InternalServiceUrlOptions,
  internalServiceUrl,
  nodeApiApp,
  staticSpaApp,
  validateAppConfig,
} from "../src/index.js";
import type { DeployDeclaration } from "../src/index.js";

const TEST_SECRET = {
  name: "platform/clerk-secret-key",
  tier: "platform",
  consumedBy: "a test fixture only.",
};

const FROM_LINES = {
  base: "FROM node:${NODE_VERSION}-alpine AS base",
  runtime: "FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:deadbeef AS runtime",
};

const API_FROM_LINES = {
  base: "FROM node:${NODE_VERSION}-alpine AS base",
  runtime: "FROM node:${NODE_VERSION}-alpine AS runtime",
};

function declarationsFrom(source: string): DeployDeclaration[] {
  return JSON.parse(
    source
      .slice(source.indexOf(" = ") + 3)
      .trim()
      .slice(0, -1),
  ) as DeployDeclaration[];
}

describe("deployDeclarationsModule", () => {
  it("preserves declared sources and committed defaults without copying registry data or runtime values", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [{ name: "NODE_ENV", value: "production", comment: ["not metadata"] }],
      composeEnv: [
        { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
        { name: "COMPUTED", value: { kind: "generated", name: "COMPUTED", value: "a,b" } },
        { name: "OPTIONAL", value: { kind: "variable", name: "PLATFORM_OPTIONAL", default: "" } },
        { name: "TOKEN", value: { kind: "variable", name: "PLATFORM_TOKEN", bootstrap: true } },
        {
          name: "KEY",
          value: { kind: "secrets-store", name: "PLATFORM_KEY", secret: TEST_SECRET },
        },
      ],
      volumes: [],
    });
    const source = deployDeclarationsModule([config]);
    const declarations = declarationsFrom(source);
    expect(declarations).toEqual([
      {
        appDir: "api",
        packageName: "@unimatrix/api",
        kind: "node-api",
        configPath: "apps/api/deploy.config.ts",
        composePath: "infra/docker/api-compose.yaml",
        image: "ghcr.io/unimatrixcore/unimatrix-api",
        containerPort: 3001,
        publicStatus: false,
        healthProbe: { url: "http://api:3001/health" },
        env: [
          { name: "COMPUTED", source: { kind: "generated", name: "COMPUTED", value: "a,b" } },
          { name: "HOST", source: { kind: "literal", value: "0.0.0.0" } },
          { name: "IMAGE_TAG", source: { kind: "variable", name: "IMAGE_TAG", required: true } },
          {
            name: "KEY",
            source: {
              kind: "secrets-store",
              name: "PLATFORM_KEY",
              secretName: TEST_SECRET.name,
              required: true,
            },
          },
          {
            name: "OPTIONAL",
            source: {
              kind: "variable",
              name: "PLATFORM_OPTIONAL",
              required: false,
              defaultValue: "",
            },
          },
          {
            name: "TOKEN",
            source: { kind: "variable", name: "PLATFORM_TOKEN", required: true, bootstrap: true },
          },
        ],
        dockerfileEnv: [{ name: "NODE_ENV", value: "production" }],
        buildArgs: [],
      },
    ]);
    expect(source).not.toContain(TEST_SECRET.consumedBy);
    expect(source).not.toContain("not metadata");
    expect(deployDesiredStateModule([config])).not.toContain("0.0.0.0");
    expect(deployDesiredStateModule([config])).not.toContain("a,b");
  });

  it("sorts apps and build args while preserving absent defaults separately from declared values", () => {
    const web = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      publicStatus: true,
      buildArgs: [{ name: "Z", default: 'https://example.com/"quoted"' }, { name: "A" }],
    });
    const admin = staticSpaApp({ appDir: "admin", packageName: "@unimatrix/admin", buildArgs: [] });
    const source = deployDeclarationsModule([web, admin]);
    const declarations = declarationsFrom(source);
    expect(declarations.map(({ appDir }) => appDir)).toEqual(["admin", "web"]);
    expect(declarations[1]).toMatchObject({
      publicStatus: true,
      dockerfileEnv: [],
      buildArgs: [{ name: "A" }, { name: "Z", defaultValue: 'https://example.com/"quoted"' }],
    });
    expect(source.startsWith("// GENERATED")).toBe(true);
    expect(source).toContain('import type { DeployDeclaration } from "@unimatrix/deploy-config";');
    expect(source).not.toMatch(/^import \{/mu);
    expect(deployDesiredStateModule([web])).not.toContain("https://example.com/");
  });
});

describe("staticSpaApp / dockerfileFor / composeFor", () => {
  it("omits ARG/ENV entirely for an app with no build args", () => {
    const config = staticSpaApp({
      appDir: "cflop",
      packageName: "@unimatrix/cflop",
      buildArgs: [],
    });

    const dockerfile = dockerfileFor(config, FROM_LINES);
    expect(dockerfile).not.toContain("ARG VITE_");
    expect(dockerfile.startsWith("# syntax=docker/dockerfile:1.7\n")).toBe(true);
    // The GENERATED banner must be line 2, or BuildKit demotes the syntax
    // directive to a plain comment and silently falls back to the legacy
    // frontend — see the package AGENTS.md and the plan this implements.
    expect(dockerfile.split("\n")[1]?.startsWith("# GENERATED")).toBe(true);

    const compose = composeFor(config);
    expect(compose).toContain("image: ghcr.io/unimatrixcore/unimatrix-cflop:${IMAGE_TAG}");
    expect(compose).not.toContain("build:");
  });

  it("pairs each ARG with its ENV, with a default that has no trailing empty ENV default", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL", default: "/api" }],
    });

    const dockerfile = dockerfileFor(config, FROM_LINES);
    expect(dockerfile).toContain(
      "ARG VITE_API_BASE_URL=/api\nENV VITE_API_BASE_URL=${VITE_API_BASE_URL}",
    );
  });

  it("emits a comment above an ARG with no default, and no comment when none is given", () => {
    const config = staticSpaApp({
      appDir: "auth",
      packageName: "@unimatrix/auth-app",
      buildArgs: [
        { name: "VITE_API_BASE_URL", default: "/api" },
        { name: "VITE_CLERK_PUBLISHABLE_KEY", comment: ["The Clerk publishable key is public."] },
      ],
    });

    const dockerfile = dockerfileFor(config, FROM_LINES);
    expect(dockerfile).toContain(
      "# The Clerk publishable key is public.\nARG VITE_CLERK_PUBLISHABLE_KEY\n",
    );
    expect(dockerfile).toContain("RUN pnpm --filter @unimatrix/auth-app build");
  });

  it("re-emits the given FROM lines verbatim rather than deriving them", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const dockerfile = dockerfileFor(config, FROM_LINES);

    expect(dockerfile).toContain(FROM_LINES.base);
    expect(dockerfile).toContain(FROM_LINES.runtime);
  });

  it("prunes the named package and installs from the pruned lockfile, not the whole workspace", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const dockerfile = dockerfileFor(config, FROM_LINES);

    expect(dockerfile).toContain("RUN turbo prune @unimatrix/web --docker");
    expect(dockerfile).toContain("COPY --from=prune /workspace/out/json/ .");
    expect(dockerfile).toContain("RUN pnpm install --frozen-lockfile");
    expect(dockerfile).not.toContain("COPY . .\nRUN pnpm install");
    expect(dockerfile).not.toContain("find . -name");
  });

  it("emits the ARG/ENV build-arg block after the install line, not before it", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL", default: "/api" }],
    });
    const lines = dockerfileFor(config, FROM_LINES).split("\n");

    const installIndex = lines.indexOf("RUN pnpm install --frozen-lockfile");
    const argIndex = lines.indexOf("ARG VITE_API_BASE_URL=/api");

    expect(installIndex).toBeGreaterThan(-1);
    expect(argIndex).toBeGreaterThan(installIndex);
  });

  it("copies each extraBuildPaths entry into the build stage, and nothing when omitted", () => {
    const withPaths = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [],
      extraBuildPaths: ["content/home"],
    });
    expect(dockerfileFor(withPaths, FROM_LINES)).toContain("COPY content/home ./content/home");

    const withoutPaths = staticSpaApp({
      appDir: "cflop",
      packageName: "@unimatrix/cflop",
      buildArgs: [],
    });
    expect(dockerfileFor(withoutPaths, FROM_LINES)).not.toContain("COPY content/home");
  });
});

describe("nodeApiApp / dockerfileFor / composeFor", () => {
  const config = nodeApiApp({
    appDir: "api",
    packageName: "@unimatrix/api",
    dockerfileEnv: [
      { name: "NODE_ENV", value: "production" },
      { name: "DATABASE_URL", value: "/data/unimatrix.sqlite", comment: ["Lives under /data."] },
    ],
    composeEnv: [
      { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
      { name: "TRUST_PROXY", value: { kind: "literal", value: '"1"' } },
      { name: "CORS_ALLOWED_ORIGINS", value: { kind: "variable", name: "CORS_ALLOWED_ORIGINS" } },
      {
        name: "CLERK_SECRET_KEY",
        value: { kind: "variable", name: "CLERK_SECRET_KEY" },
        comment: ["Required together in production."],
      },
    ],
    volumes: [{ name: "api-data", mountPath: "/data" }],
  });

  it("emits the ENV lines and mkdir/chown target from config, not hardcoded", () => {
    const dockerfile = dockerfileFor(config, API_FROM_LINES);
    expect(dockerfile).toContain("ENV NODE_ENV=production");
    expect(dockerfile).toContain("# Lives under /data.\nENV DATABASE_URL=/data/unimatrix.sqlite");
    expect(dockerfile).toContain("RUN mkdir -p /data && chown node:node /data");
    expect(dockerfile).toContain('RUN pnpm --filter "@unimatrix/api..." build');
  });

  it("keeps comments inside environment: indented at least 6 spaces (A6)", () => {
    const compose = composeFor(config);
    const lines = compose.split("\n");
    const startIndex = lines.findIndex((line) => line === "    environment:");
    expect(startIndex).toBeGreaterThan(-1);

    for (let i = startIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || /^\s{0,4}\S/u.test(line)) break;
      if (line.trim().startsWith("#")) {
        const indent = line.length - line.trimStart().length;
        expect(indent).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("references a composeEnv variable with no default in the bare form", () => {
    // A `:-default` here would be the silent failure: an unset variable reaches
    // the container as an empty string rather than as absent, and this app's
    // loader refuses an empty value — so the bare form is what turns a variable
    // nobody set into a service that stops instead of one running on a fallback
    // nobody chose.
    expect(composeFor(config)).toContain("CORS_ALLOWED_ORIGINS: ${CORS_ALLOWED_ORIGINS}");
  });

  it("declares the named volume both on the service and at the top level", () => {
    const compose = composeFor(config);
    expect(compose).toContain("    volumes:\n      - api-data:/data");
    expect(compose).toMatch(/\nvolumes:\n {2}api-data:\n?$/u);
  });

  // The Dockerfile and the compose file are rendered separately from one
  // config, so a volume the compose file mounts but the Dockerfile never
  // chowns would mount root-owned and be unwritable by `node`.
  it("initializes every volume mount path, not just the first", () => {
    const twoVolumes = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [
        { name: "api-data", mountPath: "/data" },
        { name: "api-uploads", mountPath: "/uploads" },
      ],
    });

    const dockerfile = dockerfileFor(twoVolumes, API_FROM_LINES);
    expect(dockerfile).toContain("RUN mkdir -p /data && chown node:node /data");
    expect(dockerfile).toContain("RUN mkdir -p /uploads && chown node:node /uploads");

    const compose = composeFor(twoVolumes);
    expect(compose).toContain("- api-data:/data");
    expect(compose).toContain("- api-uploads:/uploads");
  });

  it("probes http by default and https when the scheme says so", () => {
    expect(dockerfileFor(config, API_FROM_LINES)).toContain("fetch('http://127.0.0.1:'");

    const tlsConfig = nodeApiApp({
      appDir: "secrets",
      packageName: "@unimatrix/secrets-app",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
      healthcheckScheme: "https",
    });

    const dockerfile = dockerfileFor(tlsConfig, API_FROM_LINES);
    expect(dockerfile).toContain("require('node:https')");
    expect(dockerfile).toContain("rejectUnauthorized: false");
    expect(dockerfile).not.toContain("fetch('http://127.0.0.1:'");
  });

  it("defers the scheme to a variable when one is named", () => {
    const deferred = nodeApiApp({
      appDir: "secrets",
      packageName: "@unimatrix/secrets-app",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
      healthcheckScheme: { kind: "variable", name: "SECRETS_TLS_CERT_BASE64" },
    });

    expect(dockerfileFor(deferred, API_FROM_LINES)).toContain(
      "require(process.env.SECRETS_TLS_CERT_BASE64 ? 'node:https' : 'node:http')",
    );
  });

  it("rejects a healthcheck variable with an empty name", () => {
    expect(
      validateAppConfig(
        nodeApiApp({
          appDir: "secrets",
          packageName: "@unimatrix/secrets-app",
          dockerfileEnv: [],
          composeEnv: [],
          volumes: [],
          healthcheckScheme: { kind: "variable", name: "" },
        }),
      ),
    ).toEqual([
      "secrets: healthcheckScheme names an empty environment variable, so the probe " +
        "would always choose http and a TLS listener would never answer it.",
    ]);
  });

  it("declares each network on the service and as external at the top level", () => {
    const networked = nodeApiApp({
      appDir: "secrets",
      packageName: "@unimatrix/secrets-app",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
      networks: [
        { name: "unimatrix-secrets", external: true, aliases: ["secrets"], comment: ["Shared."] },
        { name: "dokploy-network", external: true },
      ],
    });

    const compose = composeFor(networked);
    expect(compose).toContain(
      "    networks:\n      # Shared.\n      unimatrix-secrets:\n        aliases:\n          - secrets\n      dokploy-network:\n",
    );
    expect(compose).toContain(
      "\nnetworks:\n  unimatrix-secrets:\n    external: true\n  dokploy-network:\n    external: true\n",
    );
  });

  it("emits no networks block at all when none are declared", () => {
    expect(composeFor(config)).not.toContain("networks:");
  });

  it("prunes the named package and installs from the pruned lockfile, not the whole workspace", () => {
    const dockerfile = dockerfileFor(config, API_FROM_LINES);

    expect(dockerfile).toContain("RUN turbo prune @unimatrix/api --docker");
    expect(dockerfile).toContain("COPY --from=prune /workspace/out/json/ .");
    expect(dockerfile).toContain("RUN pnpm install --frozen-lockfile");
    expect(dockerfile).not.toContain("COPY . .\nRUN pnpm install");
    expect(dockerfile).not.toContain("find . -name");
  });
});

describe("DeployComposeValue: secrets-store and generated", () => {
  it("renders a secrets-store value as a bare ${NAME}, with the registry name never leaking into compose output", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        {
          name: "CLERK_SECRET_KEY",
          value: { kind: "secrets-store", name: "CLERK_SECRET_KEY", secret: TEST_SECRET },
        },
      ],
      volumes: [],
    });

    const compose = composeFor(config);
    expect(compose).toContain("CLERK_SECRET_KEY: ${CLERK_SECRET_KEY}");
    expect(compose).not.toContain("platform/");
  });

  it("never renders a :-default for a secrets-store value, under any input", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        {
          name: "CLERK_SECRET_KEY",
          value: { kind: "secrets-store", name: "CLERK_SECRET_KEY", secret: TEST_SECRET },
        },
      ],
      volumes: [],
    });

    // DeployComposeValue's secrets-store variant has no `default` field at
    // all, so there is no input that could make this render `:-`.
    expect(composeFor(config)).not.toContain(":-");
  });

  it("renders a generated value as its baked literal", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        { name: "COMPUTED", value: { kind: "generated", name: "COMPUTED", value: "baked-value" } },
      ],
      volumes: [],
    });

    expect(composeFor(config)).toContain("COMPUTED: baked-value");
  });
});

describe("validateAppConfig", () => {
  it("passes a well-formed static SPA config", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL", default: "/api" }],
    });
    expect(validateAppConfig(config)).toEqual([]);
  });

  it("rejects an empty-string build arg default", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL", default: "" }],
    });
    const failures = validateAppConfig(config);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("empty-string default");
  });

  it("rejects a build arg with no default at all, not just an empty one", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL" }],
    });
    const failures = validateAppConfig(config);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("has no default");
  });

  it("rejects a duplicate build arg name", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [{ name: "VITE_API_BASE_URL" }, { name: "VITE_API_BASE_URL" }],
    });
    expect(validateAppConfig(config).some((message) => message.includes("more than once"))).toBe(
      true,
    );
  });

  it("rejects a packageName that does not start with @unimatrix/", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "web", buildArgs: [] });
    expect(validateAppConfig(config).some((message) => message.includes("@unimatrix/"))).toBe(true);
  });

  it("passes a well-formed node-api config", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [{ name: "HOST", value: { kind: "literal", value: "0.0.0.0" } }],
      volumes: [{ name: "api-data", mountPath: "/data" }],
    });
    expect(validateAppConfig(config)).toEqual([]);
  });

  it("rejects an empty-string composeEnv variable default", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        {
          name: "CORS_ALLOWED_ORIGINS",
          value: { kind: "variable", name: "CORS_ALLOWED_ORIGINS", default: "" },
        },
      ],
      volumes: [],
    });
    const failures = validateAppConfig(config);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("empty-string default");
  });

  it("rejects a secrets-store composeEnv entry with an empty compose variable name", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        {
          name: "CLERK_SECRET_KEY",
          value: { kind: "secrets-store", name: "", secret: TEST_SECRET },
        },
      ],
      volumes: [],
    });
    expect(validateAppConfig(config)).toEqual([
      "api: composeEnv CLERK_SECRET_KEY is secrets-store with an empty compose variable name, " +
        "so the compose file would render ${}.",
    ]);
  });

  it("rejects a secrets-store composeEnv entry with an empty registry entry name", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        {
          name: "CLERK_SECRET_KEY",
          value: {
            kind: "secrets-store",
            name: "CLERK_SECRET_KEY",
            secret: { name: "", tier: "platform", consumedBy: "test" },
          },
        },
      ],
      volumes: [],
    });
    expect(validateAppConfig(config)).toEqual([
      "api: composeEnv CLERK_SECRET_KEY is secrets-store with an empty registry entry name. " +
        "Pass the exported constant from @unimatrix/shared/secrets-registry, not an inline object.",
    ]);
  });

  it("rejects a generated composeEnv entry with an empty computed value", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [{ name: "COMPUTED", value: { kind: "generated", name: "COMPUTED", value: "" } }],
      volumes: [],
    });
    expect(validateAppConfig(config)).toEqual([
      "api: composeEnv COMPUTED is generated with an empty computed value, which bakes an empty " +
        "string into the compose file exactly as silently as no value at all.",
    ]);
  });

  it("rejects a volume mount path that is not absolute", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [{ name: "api-data", mountPath: "data" }],
    });
    expect(validateAppConfig(config).some((message) => message.includes("not absolute"))).toBe(
      true,
    );
  });

  it("rejects a non-external network, a duplicate one, and an empty name", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
      networks: [
        { name: "unimatrix-secrets", external: false },
        { name: "unimatrix-secrets", external: true },
        { name: "", external: true },
      ],
    });

    const failures = validateAppConfig(config);
    expect(failures.some((message) => message.includes("is not external"))).toBe(true);
    expect(failures.some((message) => message.includes("declared more than once"))).toBe(true);
    expect(failures.some((message) => message.includes("empty name"))).toBe(true);
  });

  it("rejects an empty appDir", () => {
    const config = staticSpaApp({ appDir: "", packageName: "@unimatrix/web", buildArgs: [] });
    expect(
      validateAppConfig(config).some((message) => message.includes("appDir must not be empty")),
    ).toBe(true);
  });

  it("rejects an appDir that is not a legal image name component", () => {
    const rejected = staticSpaApp({ appDir: "Web", packageName: "@unimatrix/web", buildArgs: [] });
    expect(
      validateAppConfig(rejected).some((message) =>
        message.includes("ghcr.io/unimatrixcore/unimatrix-Web:${IMAGE_TAG}"),
      ),
    ).toBe(true);

    const accepted = staticSpaApp({
      appDir: "cflop",
      packageName: "@unimatrix/cflop",
      buildArgs: [],
    });
    expect(validateAppConfig(accepted)).toEqual([]);
  });

  it("accepts a well-formed extraBuildPaths entry", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [],
      extraBuildPaths: ["content/home"],
    });
    expect(validateAppConfig(config)).toEqual([]);
  });

  it("rejects an empty extraBuildPaths entry", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [],
      extraBuildPaths: [""],
    });
    expect(validateAppConfig(config).some((message) => message.includes("is empty"))).toBe(true);
  });

  it("rejects an absolute extraBuildPaths entry", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [],
      extraBuildPaths: ["/etc/passwd"],
    });
    expect(validateAppConfig(config).some((message) => message.includes("absolute"))).toBe(true);
  });

  it("rejects an extraBuildPaths entry with a .. segment", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [],
      extraBuildPaths: ["content/../../etc"],
    });
    expect(validateAppConfig(config).some((message) => message.includes('".." segment'))).toBe(
      true,
    );
  });
});

describe("container ports", () => {
  it("exposes 8080 on a static-spa image, matching the healthcheck URL", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const dockerfile = dockerfileFor(config, FROM_LINES);

    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain("http://127.0.0.1:8080/");
  });

  it("exposes 3001 on a node-api image, matching the healthcheck fallback port", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
    });
    const dockerfile = dockerfileFor(config, API_FROM_LINES);

    expect(dockerfile).toContain("EXPOSE 3001");
    expect(dockerfile).toContain("process.env.PORT ?? '3001'");
  });
});

describe("deployDesiredStateModule", () => {
  it("emits a GENERATED banner and an import type, never a value import", () => {
    const config = staticSpaApp({
      appDir: "cflop",
      packageName: "@unimatrix/cflop",
      buildArgs: [],
    });
    const source = deployDesiredStateModule([config]);

    expect(source.startsWith("// GENERATED")).toBe(true);
    expect(source).toContain('import type { DeployDesiredState } from "@unimatrix/deploy-config";');
    expect(source).not.toMatch(/^import \{/mu);
  });

  it("sorts services by appDir regardless of input order", () => {
    const web = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const admin = staticSpaApp({ appDir: "admin", packageName: "@unimatrix/admin", buildArgs: [] });
    const source = deployDesiredStateModule([web, admin]);

    expect(source.indexOf('appDir: "admin"')).toBeLessThan(source.indexOf('appDir: "web"'));
  });

  it("carries IMAGE_TAG (required) plus every variable- and secrets-store-kind composeEnv entry, sorted by name", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [
        { name: "HOST", value: { kind: "literal", value: "0.0.0.0" } },
        {
          name: "COMPUTED",
          value: { kind: "generated", name: "COMPUTED", value: "baked-value" },
        },
        { name: "CLERK_SECRET_KEY", value: { kind: "variable", name: "CLERK_SECRET_KEY" } },
        {
          name: "TRUST_PROXY",
          value: { kind: "variable", name: "TRUST_PROXY", default: "1" },
        },
        {
          name: "CLERK_JWT_KEY",
          value: { kind: "secrets-store", name: "CLERK_JWT_KEY", secret: TEST_SECRET },
        },
      ],
      volumes: [],
    });
    const source = deployDesiredStateModule([config]);

    // Neither a literal-kind entry (HOST) nor a generated-kind entry
    // (COMPUTED) appears at all — only variable- and secrets-store-kind do.
    expect(source).not.toContain('name: "HOST"');
    expect(source).not.toContain('name: "COMPUTED"');
    expect(source).toContain('{ name: "CLERK_SECRET_KEY", required: true }');
    expect(source).toContain(
      '{ name: "CLERK_JWT_KEY", required: true, secretName: "platform/clerk-secret-key" }',
    );
    // A plain variable and IMAGE_TAG both omit the secretName key entirely,
    // rather than carrying it as `undefined`.
    expect(source).toContain('{ name: "IMAGE_TAG", required: true }');
    expect(source).toContain('{ name: "TRUST_PROXY", required: false }');
    expect(source).not.toContain('{ name: "IMAGE_TAG", required: true, secretName');
    expect(source).not.toContain('{ name: "TRUST_PROXY", required: false, secretName');
    // Sorted: CLERK_JWT_KEY < CLERK_SECRET_KEY < IMAGE_TAG < TRUST_PROXY.
    expect(source.indexOf('name: "CLERK_JWT_KEY"')).toBeLessThan(
      source.indexOf('name: "CLERK_SECRET_KEY"'),
    );
    expect(source.indexOf('name: "CLERK_SECRET_KEY"')).toBeLessThan(
      source.indexOf('name: "IMAGE_TAG"'),
    );
    expect(source.indexOf('name: "IMAGE_TAG"')).toBeLessThan(source.indexOf('name: "TRUST_PROXY"'));
  });

  it("declares only IMAGE_TAG for a static-spa app, which has no composeEnv", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const source = deployDesiredStateModule([config]);

    expect(source).toContain('env: [\n      { name: "IMAGE_TAG", required: true },\n    ]');
  });

  it("carries static SPA build-arg names without their image-baked defaults", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      buildArgs: [
        { name: "VITE_CLERK_PUBLISHABLE_KEY", default: "pk_test_Canary" },
        { name: "VITE_API_BASE_URL", default: "https://example.com" },
      ],
    });
    const source = deployDesiredStateModule([config]);

    expect(source).toContain('buildArgNames: ["VITE_API_BASE_URL","VITE_CLERK_PUBLISHABLE_KEY"]');
    expect(source).not.toContain("pk_test_Canary");
    expect(source).not.toContain("https://example.com");
  });

  it("carries a repo-root-relative composePath with no leading ./", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const source = deployDesiredStateModule([config]);

    expect(source).toContain('composePath: "infra/docker/web-compose.yaml"');
  });

  it("carries the right containerPort per kind", () => {
    const spa = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const api = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
    });

    expect(deployDesiredStateModule([spa])).toContain("containerPort: 8080");
    expect(deployDesiredStateModule([api])).toContain("containerPort: 3001");
  });
});

describe("publicStatus", () => {
  it("defaults to false on a static-spa config", () => {
    const config = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    expect(deployDesiredStateModule([config])).toContain("publicStatus: false,");
  });

  it("defaults to false on a node-api config", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
    });
    expect(deployDesiredStateModule([config])).toContain("publicStatus: false,");
  });

  it("carries true when opted in on a static-spa config", () => {
    const config = staticSpaApp({
      appDir: "web",
      packageName: "@unimatrix/web",
      publicStatus: true,
      buildArgs: [],
    });
    expect(deployDesiredStateModule([config])).toContain("publicStatus: true,");
  });

  it("carries true when opted in on a node-api config", () => {
    const config = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      publicStatus: true,
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
    });
    expect(deployDesiredStateModule([config])).toContain("publicStatus: true,");
  });
});

describe("internalServiceUrl", () => {
  it("defaults to the https scheme", () => {
    expect(internalServiceUrl("secrets")).toBe("https://secrets:3001");
  });

  it("accepts an explicit scheme", () => {
    expect(internalServiceUrl("secrets", { scheme: "http" })).toBe("http://secrets:3001");
  });

  it("tracks the node-api container port by default, and the static-spa port when named", () => {
    expect(internalServiceUrl("api", { kind: "node-api" })).toBe("https://api:3001");
    expect(internalServiceUrl("web", { kind: "static-spa" })).toBe("https://web:8080");
  });

  it("takes its options as the exported InternalServiceUrlOptions type", () => {
    const options: InternalServiceUrlOptions = { kind: "static-spa", scheme: "http" };
    expect(internalServiceUrl("web", options)).toBe("http://web:8080");
  });
});

describe("healthProbe", () => {
  it("generates internal paths and explicit TLS trust configuration", () => {
    const spa = staticSpaApp({ appDir: "web", packageName: "@unimatrix/web", buildArgs: [] });
    const api = nodeApiApp({
      appDir: "api",
      packageName: "@unimatrix/api",
      dockerfileEnv: [],
      composeEnv: [],
      volumes: [],
    });
    const secrets = nodeApiApp({
      ...api,
      appDir: "secrets",
      healthProbe: { scheme: "https", caCertificateEnv: "SECRETS_TLS_CERT_BASE64" },
    });
    expect(deployDesiredStateModule([spa])).toContain('"url":"http://web:8080/"');
    expect(deployDesiredStateModule([api])).toContain('"url":"http://api:3001/health"');
    expect(deployDesiredStateModule([secrets])).toContain(
      '"url":"https://secrets:3001/health","caCertificateEnv":"SECRETS_TLS_CERT_BASE64"',
    );
    expect(validateAppConfig(secrets)).toEqual([]);
  });

  it("rejects a pin on cleartext and malformed certificate variable names", () => {
    for (const healthProbe of [
      { scheme: "http" as const, caCertificateEnv: "CERT" },
      { scheme: "https" as const, caCertificateEnv: "BAD-NAME" },
    ]) {
      const config = staticSpaApp({
        appDir: "web",
        packageName: "@unimatrix/web",
        buildArgs: [],
        healthProbe,
      });
      expect(validateAppConfig(config)).toContain(
        "web: healthProbe.caCertificateEnv requires https and a valid environment variable name.",
      );
    }
  });
});
