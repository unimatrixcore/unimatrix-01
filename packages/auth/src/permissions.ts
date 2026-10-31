/**
 * Framework-agnostic permission scheme for the Unimatrix ecosystem.
 *
 * This module is the single source of truth for the shape of permission
 * data as it is stored in Clerk `user.publicMetadata` and as it is
 * surfaced into the session token via session-token customization (see
 * this package's README). Both `./server` (reading the verified session
 * claim) and `./react` (reading `publicMetadata` directly) build on the
 * types and helpers defined here.
 *
 * Keep this file dependency-free: no framework imports, no Node-only or
 * browser-only APIs. It must be safe to import from any runtime.
 */

/** App slugs that participate in the Unimatrix permission scheme. */
export const APP_SLUGS = ["web", "cflop", "auth", "admin", "api"] as const;

/** A registered app slug. */
export type AppSlug = (typeof APP_SLUGS)[number];

/** Roles assignable to a user, per app. */
export const ROLES = ["viewer", "editor", "admin"] as const;

/** A permission role. */
export type Role = (typeof ROLES)[number];

/**
 * The exact shape stored in Clerk `user.publicMetadata`. This is the
 * single source of truth for a user's permissions: every app slug maps to
 * the list of roles the user holds for that app. Absent app slugs mean the
 * user holds no roles for that app.
 *
 * @example
 * ```json
 * {
 *   "permissions": {
 *     "web": ["viewer"],
 *     "auth": ["admin"]
 *   }
 * }
 * ```
 */
export interface UserPermissionsMetadata {
  permissions: Partial<Record<AppSlug, Role[]>>;
}

/**
 * The shape of the custom `permissions` claim carried in the session
 * token (see the session-token customization steps documented in this
 * package's README). Values are typed loosely as `string[]` because they
 * originate from an external, verified-but-untyped token and must be
 * normalized before use.
 */
export interface SessionPermissionsClaim {
  permissions?: Partial<Record<string, string[]>>;
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function isRoleArray(value: unknown): value is Role[] {
  return Array.isArray(value) && value.every(isRole);
}

/**
 * Determines whether the given permissions payload grants `role` for
 * `appSlug`. Accepts either the Clerk `publicMetadata` shape or the
 * session JWT claim shape, and safely handles malformed or missing input.
 */
export function hasPermission(
  perms: SessionPermissionsClaim | UserPermissionsMetadata | undefined,
  appSlug: AppSlug,
  role: Role,
): boolean {
  if (perms === undefined || typeof perms !== "object" || perms === null) {
    return false;
  }

  const { permissions } = perms;

  if (permissions === undefined || typeof permissions !== "object" || permissions === null) {
    return false;
  }

  const roles = (permissions as Record<string, unknown>)[appSlug];

  if (!isRoleArray(roles)) {
    return false;
  }

  return roles.includes(role);
}

/**
 * Determines whether the given permissions payload grants the `auth` app
 * `admin` role. This is the platform-wide administrator role: it governs
 * bootstrap and management of other users' permissions.
 */
export function isAdmin(
  perms: SessionPermissionsClaim | UserPermissionsMetadata | undefined,
): boolean {
  return hasPermission(perms, "auth", "admin");
}

/**
 * Sections of the admin app (`apps/admin`) that are gated independently.
 *
 * A section belongs here once something exists for the gate to protect. The
 * remaining `NotBuiltPlaceholder` routes under `apps/admin/src/routes` stay
 * out: naming them here would pre-commit decisions that have not been taken
 * yet.
 */
export const ADMIN_SECTIONS = ["content", "secrets", "deploys"] as const;

/** A gated section of the admin app. */
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

/**
 * The permission each admin section requires.
 *
 * Today every section maps to `auth:admin`, so
 * {@link canAccessAdminSection} is equivalent to {@link isAdmin} for every
 * section. That is deliberate: this table is the *one* place a per-section
 * capability scheme gets introduced later. Because every admin surface reads
 * its gate through {@link canAccessAdminSection}, moving a section onto its
 * own app slug or role is an edit to this record — not a change at N call
 * sites, and not a second implementation of the check.
 */
const ADMIN_SECTION_PERMISSIONS: Record<AdminSection, { appSlug: AppSlug; role: Role }> = {
  content: { appSlug: "auth", role: "admin" },
  secrets: { appSlug: "auth", role: "admin" },
  deploys: { appSlug: "auth", role: "admin" },
};

/**
 * Determines whether the given permissions payload may access `section` of
 * the admin app. Accepts either the Clerk `publicMetadata` shape or the
 * session JWT claim shape, and safely handles malformed or missing input.
 *
 * This is the single predicate every admin surface — UI and API alike —
 * gates on. `@unimatrix/auth/server`'s `requireAdminSection()` wraps this
 * function rather than re-deriving the check, so the two surfaces cannot
 * drift apart.
 */
export function canAccessAdminSection(
  perms: SessionPermissionsClaim | UserPermissionsMetadata | undefined,
  section: AdminSection,
): boolean {
  const required = ADMIN_SECTION_PERMISSIONS[section];

  // `section` is typed, but the value can still arrive from an untyped
  // boundary (a route param, a session claim). An unknown section is denied
  // rather than crashing on a destructure of `undefined`.
  if (required === undefined) {
    return false;
  }

  return hasPermission(perms, required.appSlug, required.role);
}
