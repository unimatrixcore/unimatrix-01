import { createClerkClient } from "@clerk/backend";
import type { User } from "@clerk/backend";

import { APP_SLUGS } from "./permissions.js";
import type { AppSlug, Role, UserPermissionsMetadata } from "./permissions.js";

/**
 * A plain, JSON-serializable summary of a Clerk user, shaped for admin
 * user-management UIs. Field names intentionally match
 * `@unimatrix/shared`'s `userSummarySchema` output exactly, so `apps/api`
 * can map this type straight onto that contract's response shape with zero
 * friction. This package must not depend on `@unimatrix/shared` (the
 * dependency direction stays one-way, `apps/api` -> both packages), so the
 * shapes are kept in sync by convention rather than a shared import — if
 * you change one, change the other.
 */
export interface UserSummaryData {
  id: string;
  primaryEmailAddress: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  imageUrl: string | null;
  permissions: UserPermissionsMetadata["permissions"];
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && ["viewer", "editor", "admin"].includes(value);
}

function isRoleArray(value: unknown): value is Role[] {
  return Array.isArray(value) && value.every(isRole);
}

/**
 * Normalizes an arbitrary `publicMetadata` value into the `permissions`
 * map shape, safely handling malformed or missing input. Mirrors the
 * shape-guard logic in `./permissions.js`'s `hasPermission` and
 * `./react.tsx`'s `readPermissionsMetadata`, factored out here so
 * `createUserManagementClient` can reuse it when mapping Clerk `User`
 * objects.
 */
export function normalizePermissionsMetadata(
  publicMetadata: unknown,
): UserPermissionsMetadata["permissions"] {
  if (typeof publicMetadata !== "object" || publicMetadata === null) {
    return {};
  }

  const { permissions } = publicMetadata as { permissions?: unknown };

  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return {};
  }

  const knownAppSlugs = new Set<string>(APP_SLUGS);
  const normalized: Partial<Record<AppSlug, Role[]>> = {};

  for (const [appSlug, roles] of Object.entries(permissions as Record<string, unknown>)) {
    // Drop unknown app slugs: the shared `permissionsMapSchema` used for the
    // /admin/users response rejects keys outside APP_SLUGS, so passing one
    // through here would fail response serialization and break the admin list.
    if (knownAppSlugs.has(appSlug) && isRoleArray(roles)) {
      normalized[appSlug as AppSlug] = roles;
    }
  }

  return normalized;
}

function toUserSummaryData(user: User): UserSummaryData {
  return {
    id: user.id,
    primaryEmailAddress: user.primaryEmailAddress?.emailAddress ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    imageUrl: user.imageUrl,
    permissions: normalizePermissionsMetadata(user.publicMetadata),
  };
}

/** Options accepted by {@link createUserManagementClient}. */
export interface CreateUserManagementClientOptions {
  /** Clerk secret key for the backend API client. */
  secretKey: string;
}

/** Options accepted by {@link UserManagementClient.listUsers}. */
export interface ListUsersOptions {
  /** Free-text search across email addresses, names, username, etc. */
  query?: string;
  /** Maximum number of users to return. */
  limit: number;
  /** Number of users to skip, for pagination. */
  offset: number;
}

/** Result of {@link UserManagementClient.listUsers}. */
export interface ListUsersResult {
  users: UserSummaryData[];
  totalCount: number;
}

/** Thin, Node-only wrapper around `@clerk/backend`'s user-management API. */
export interface UserManagementClient {
  listUsers(options: ListUsersOptions): Promise<ListUsersResult>;
  getUser(userId: string): Promise<UserSummaryData | null>;
  setUserPermissions(
    userId: string,
    permissions: UserPermissionsMetadata["permissions"],
  ): Promise<UserSummaryData>;
}

/**
 * Creates a {@link UserManagementClient} backed by `@clerk/backend`'s
 * `createClerkClient`. Intended for admin user-management routes (listing
 * users and updating their `permissions` `publicMetadata`) — never call
 * this from `./react`, it is Node-only.
 */
export function createUserManagementClient(
  options: CreateUserManagementClientOptions,
): UserManagementClient {
  const clerkClient = createClerkClient({ secretKey: options.secretKey });

  return {
    async listUsers({ query, limit, offset }: ListUsersOptions): Promise<ListUsersResult> {
      const [{ data: users }, totalCount] = await Promise.all([
        clerkClient.users.getUserList({ ...(query === undefined ? {} : { query }), limit, offset }),
        clerkClient.users.getCount(query === undefined ? undefined : { query }),
      ]);

      return {
        users: users.map(toUserSummaryData),
        totalCount,
      };
    },

    async getUser(userId: string): Promise<UserSummaryData | null> {
      try {
        const user = await clerkClient.users.getUser(userId);
        return toUserSummaryData(user);
      } catch {
        return null;
      }
    },

    async setUserPermissions(
      userId: string,
      permissions: UserPermissionsMetadata["permissions"],
    ): Promise<UserSummaryData> {
      const user = await clerkClient.users.updateUserMetadata(userId, {
        publicMetadata: { permissions },
      });

      return toUserSummaryData(user);
    },
  };
}
