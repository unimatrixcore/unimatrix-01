import { describe, expect, it } from "vitest";

import type { SessionPermissionsClaim } from "../src/permissions.js";
import {
  ADMIN_SECTIONS,
  APP_SLUGS,
  canAccessAdminSection,
  hasPermission,
  isAdmin,
} from "../src/permissions.js";

describe("hasPermission", () => {
  it("returns true when the role is present for the app slug", () => {
    expect(hasPermission({ permissions: { web: ["viewer", "editor"] } }, "web", "editor")).toBe(
      true,
    );
  });

  it("returns false when the role is absent for the app slug", () => {
    expect(hasPermission({ permissions: { web: ["viewer"] } }, "web", "admin")).toBe(false);
  });

  it("returns false when the app slug is absent", () => {
    expect(hasPermission({ permissions: { web: ["admin"] } }, "api", "admin")).toBe(false);
  });

  it("returns false when perms is undefined", () => {
    expect(hasPermission(undefined, "web", "viewer")).toBe(false);
  });

  it("returns false when perms is null-ish or not an object", () => {
    expect(hasPermission(null as never, "web", "viewer")).toBe(false);
    expect(hasPermission("nonsense" as never, "web", "viewer")).toBe(false);
  });

  it("returns false when permissions is missing", () => {
    expect(hasPermission({}, "web", "viewer")).toBe(false);
  });

  it("returns false when permissions is malformed (not an object)", () => {
    expect(hasPermission({ permissions: "nope" } as never, "web", "viewer")).toBe(false);
    expect(hasPermission({ permissions: null } as never, "web", "viewer")).toBe(false);
  });

  it("returns false when the role list for the app slug is malformed", () => {
    expect(hasPermission({ permissions: { web: "admin" } } as never, "web", "admin")).toBe(false);
    expect(hasPermission({ permissions: { web: [1, 2, 3] } } as never, "web", "admin")).toBe(false);
  });

  it("ignores unknown role strings in an otherwise valid role list", () => {
    expect(
      hasPermission({ permissions: { web: ["viewer", "superuser"] } }, "web", "superuser" as never),
    ).toBe(false);
  });

  it("works with the session JWT claim shape", () => {
    expect(hasPermission({ permissions: { auth: ["admin"] } }, "auth", "admin")).toBe(true);
  });
});

describe("isAdmin", () => {
  it("returns true when the user holds the auth admin role", () => {
    expect(isAdmin({ permissions: { auth: ["admin"] } })).toBe(true);
  });

  it("returns false when the user holds a non-admin auth role", () => {
    expect(isAdmin({ permissions: { auth: ["viewer"] } })).toBe(false);
  });

  it("returns false when the user holds admin for a different app", () => {
    expect(isAdmin({ permissions: { web: ["admin"] } })).toBe(false);
  });

  it("returns false when perms is undefined", () => {
    expect(isAdmin(undefined)).toBe(false);
  });
});

describe("APP_SLUGS", () => {
  it("includes the admin app", () => {
    expect(APP_SLUGS).toContain("admin");
  });
});

describe("ADMIN_SECTIONS", () => {
  it("includes the deploys section", () => {
    expect(ADMIN_SECTIONS).toContain("deploys");
  });

  it("includes the secrets section", () => {
    expect(ADMIN_SECTIONS).toContain("secrets");
  });
});

describe("canAccessAdminSection", () => {
  it.each(ADMIN_SECTIONS)("allows an auth admin into the %s section", (section) => {
    expect(canAccessAdminSection({ permissions: { auth: ["admin"] } }, section)).toBe(true);
  });

  it.each(ADMIN_SECTIONS)("denies a non-admin the %s section", (section) => {
    expect(canAccessAdminSection({ permissions: { auth: ["editor"] } }, section)).toBe(false);
  });

  /**
   * The spec's decision, asserted rather than assumed: every section is gated
   * on `auth:admin` today, so the predicate and `isAdmin` must not have
   * drifted apart. When per-section capabilities land, this is the test that
   * is expected to change.
   */
  it.each(ADMIN_SECTIONS)("agrees with isAdmin for the %s section today", (section) => {
    const cases: (SessionPermissionsClaim | undefined)[] = [
      undefined,
      {},
      { permissions: {} },
      { permissions: { auth: ["admin"] } },
      { permissions: { auth: ["viewer"] } },
      { permissions: { web: ["admin"] } },
      { permissions: { admin: ["admin"] } },
    ];

    for (const perms of cases) {
      expect(canAccessAdminSection(perms, section)).toBe(isAdmin(perms));
    }
  });

  it("returns false when perms is undefined", () => {
    expect(canAccessAdminSection(undefined, "content")).toBe(false);
  });

  it("returns false for malformed permission payloads", () => {
    expect(canAccessAdminSection(null as never, "content")).toBe(false);
    expect(canAccessAdminSection({ permissions: "nope" } as never, "content")).toBe(false);
    expect(canAccessAdminSection({ permissions: { auth: "admin" } } as never, "content")).toBe(
      false,
    );
  });

  it("denies an unknown section reaching it from an untyped boundary", () => {
    expect(canAccessAdminSection({ permissions: { auth: ["admin"] } }, "unknown" as never)).toBe(
      false,
    );
  });

  it("does not grant access from the admin app slug alone", () => {
    // `"admin"` is now a registered app slug, but the gate is still
    // `auth:admin`. Holding `admin:admin` must not be a way in.
    expect(canAccessAdminSection({ permissions: { admin: ["admin"] } }, "content")).toBe(false);
  });
});
