import { z } from "zod";

const appIdentifierSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
const nameSchema = z.string().min(1).max(256);
const valueSchema = z.string().max(65536);
const pathSchema = z.string().min(1).max(4096);

export const deployDeclarationsQuerySchema = z.strictObject({
  app: appIdentifierSchema.optional(),
});

const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("literal"), value: valueSchema }),
  z.strictObject({ kind: z.literal("generated"), name: nameSchema, value: valueSchema }),
  z.strictObject({
    kind: z.literal("variable"),
    name: nameSchema,
    required: z.boolean(),
    defaultValue: valueSchema.optional(),
    bootstrap: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("secrets-store"),
    name: nameSchema,
    secretName: nameSchema,
    required: z.literal(true),
  }),
]);

export const deployDeclarationSchema = z.strictObject({
  appDir: appIdentifierSchema,
  packageName: nameSchema,
  kind: z.enum(["static-spa", "node-api"]),
  configPath: pathSchema,
  composePath: pathSchema,
  image: pathSchema,
  containerPort: z.number().int().min(1).max(65535),
  publicStatus: z.boolean(),
  healthProbe: z.strictObject({ url: pathSchema, caCertificateEnv: nameSchema.optional() }),
  env: z.array(z.strictObject({ name: nameSchema, source: sourceSchema })).max(512),
  buildArgs: z
    .array(z.strictObject({ name: nameSchema, defaultValue: valueSchema.optional() }))
    .max(512),
  dockerfileEnv: z.array(z.strictObject({ name: nameSchema, value: valueSchema })).max(512),
});

export const deployDeclarationsResponseSchema = z.strictObject({
  apps: z.array(deployDeclarationSchema).max(100),
});

export type DeployDeclaration = z.output<typeof deployDeclarationSchema>;
export type DeployDeclarationsResponse = z.output<typeof deployDeclarationsResponseSchema>;
