import { z } from "zod";

/**
 * App slugs and roles participating in the Unimatrix permission scheme.
 *
 * `@unimatrix/shared` is framework-agnostic and must not depend on
 * `@unimatrix/auth`, so these enums are defined locally rather than
 * imported. They MUST stay in sync with `APP_SLUGS`/`ROLES` exported from
 * `@unimatrix/auth`'s `src/permissions.ts` — that file is the single
 * source of truth for the permission scheme; this is a mirrored copy for
 * schema validation purposes only.
 */
export const adminAppSlugSchema = z.enum(["web", "cube-trainer", "auth", "api"]);
export const adminRoleSchema = z.enum(["viewer", "editor", "admin"]);

export type AdminAppSlug = z.output<typeof adminAppSlugSchema>;
export type AdminRole = z.output<typeof adminRoleSchema>;

/**
 * The `{ [appSlug]: role[] }` permissions map, mirroring the shape of
 * `UserPermissionsMetadata["permissions"]` from `@unimatrix/auth`. Every
 * app slug key is optional; an absent key means the user holds no roles
 * for that app.
 */
export const permissionsMapSchema = z.partialRecord(adminAppSlugSchema, z.array(adminRoleSchema));

export type PermissionsMap = z.output<typeof permissionsMapSchema>;

export const userSummarySchema = z.strictObject({
  id: z.string(),
  primaryEmailAddress: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  imageUrl: z.string().nullable(),
  permissions: permissionsMapSchema,
});

export type UserSummary = z.output<typeof userSummarySchema>;

export const listUsersQuerySchema = z.strictObject({
  query: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;

export const listUsersResponseSchema = z.strictObject({
  users: z.array(userSummarySchema),
  totalCount: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
});

export type ListUsersResponse = z.output<typeof listUsersResponseSchema>;

export const updateUserPermissionsBodySchema = z.strictObject({
  userId: z.string().min(1),
  permissions: permissionsMapSchema,
});

export type UpdateUserPermissionsBody = z.output<typeof updateUserPermissionsBodySchema>;

export const updateUserPermissionsResponseSchema = userSummarySchema;

export type UpdateUserPermissionsResponse = z.output<typeof updateUserPermissionsResponseSchema>;
