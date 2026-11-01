import { describe, expect, it } from "vitest";

import { deployDeclarationsQuerySchema, deployDeclarationsResponseSchema } from "../src/index.js";

const declaration = {
  appDir: "api",
  packageName: "@unimatrix/api",
  kind: "node-api",
  configPath: "apps/api/deploy.config.ts",
  composePath: "infra/docker/api-compose.yaml",
  image: "ghcr.io/unimatrixcore/api",
  containerPort: 3001,
  publicStatus: true,
  healthProbe: { url: "http://api:3001/health" },
  env: [
    { name: "NODE_ENV", source: { kind: "literal", value: "production" } },
    { name: "PORT", source: { kind: "generated", name: "PORT", value: "3001" } },
    {
      name: "IMAGE_TAG",
      source: {
        kind: "variable",
        name: "IMAGE_TAG",
        required: false,
        defaultValue: "latest",
        bootstrap: true,
      },
    },
    {
      name: "KEY",
      source: { kind: "secrets-store", name: "KEY", secretName: "platform/key", required: true },
    },
  ],
  buildArgs: [{ name: "VITE_API_BASE_URL", defaultValue: "https://api.example.test" }],
  dockerfileEnv: [{ name: "NODE_ENV", value: "production" }],
};

describe("deployment declaration disclosure", () => {
  it("preserves committed values and store references", () => {
    expect(deployDeclarationsResponseSchema.parse({ apps: [declaration] })).toEqual({
      apps: [declaration],
    });
    expect(deployDeclarationsQuerySchema.parse({})).toEqual({});
    expect(deployDeclarationsQuerySchema.parse({ app: "api" })).toEqual({ app: "api" });
    expect(deployDeclarationsQuerySchema.safeParse({ app: "../api" }).success).toBe(false);
  });

  it.each(["value", "maskedPrefix", "preview", "defaultValue", "present"])(
    "rejects %s on a store-backed declaration",
    (field) => {
      const source = { ...declaration.env[3]?.source, [field]: "private" };
      const result = deployDeclarationsResponseSchema.safeParse({
        apps: [{ ...declaration, env: [{ name: "KEY", source }] }],
      });
      expect(result.success).toBe(false);
    },
  );

  it("rejects runtime values and unrecognized fields rather than stripping them", () => {
    expect(
      deployDeclarationsResponseSchema.safeParse({ apps: [{ ...declaration, envBlob: "private" }] })
        .success,
    ).toBe(false);
    expect(
      deployDeclarationsResponseSchema.safeParse({
        apps: [
          {
            ...declaration,
            env: [
              {
                name: "TOKEN",
                source: { kind: "variable", name: "TOKEN", required: true, value: "private" },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
