import { APP_SLUGS, ROLES, type AppSlug, type Role } from "@unimatrix/auth";
import type { PermissionsMap } from "@unimatrix/shared";

export { APP_SLUGS, ROLES };
export type { AppSlug, Role };

/**
 * Whether `permissions` grants `role` for `appSlug`. Pure, framework-free
 * helper used to render checkbox state in the admin permissions matrix.
 */
export function hasMatrixPermission(
  permissions: PermissionsMap,
  appSlug: AppSlug,
  role: Role,
): boolean {
  return (permissions[appSlug] ?? []).includes(role);
}

/**
 * Returns a new `PermissionsMap` with `role` toggled for `appSlug`,
 * leaving `permissions` untouched (immutable update, safe to use directly
 * as the next value passed to a mutation). Removes the app slug's entry
 * entirely once its role list becomes empty, so the resulting map never
 * carries stray empty arrays.
 */
export function toggleMatrixPermission(
  permissions: PermissionsMap,
  appSlug: AppSlug,
  role: Role,
): PermissionsMap {
  const currentRoles = permissions[appSlug] ?? [];
  const hasRole = currentRoles.includes(role);
  const nextRoles = hasRole
    ? currentRoles.filter((existingRole) => existingRole !== role)
    : [...currentRoles, role];

  const next: PermissionsMap = { ...permissions };

  if (nextRoles.length === 0) {
    delete next[appSlug];
  } else {
    next[appSlug] = nextRoles;
  }

  return next;
}
