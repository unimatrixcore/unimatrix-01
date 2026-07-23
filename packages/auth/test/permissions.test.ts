import { describe, expect, it } from "vitest";

import { hasPermission, isAdmin } from "../src/permissions.js";

describe("hasPermission", () => {
  it("returns true when the role is present for the app slug", () => {
    expect(
      hasPermission({ permissions: { web: ["viewer", "editor"] } }, "web", "editor"),
    ).toBe(true);
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
    expect(hasPermission({} as never, "web", "viewer")).toBe(false);
  });

  it("returns false when permissions is malformed (not an object)", () => {
    expect(hasPermission({ permissions: "nope" } as never, "web", "viewer")).toBe(false);
    expect(hasPermission({ permissions: null } as never, "web", "viewer")).toBe(false);
  });

  it("returns false when the role list for the app slug is malformed", () => {
    expect(hasPermission({ permissions: { web: "admin" } } as never, "web", "admin")).toBe(
      false,
    );
    expect(
      hasPermission({ permissions: { web: [1, 2, 3] } } as never, "web", "admin"),
    ).toBe(false);
  });

  it("ignores unknown role strings in an otherwise valid role list", () => {
    expect(
      hasPermission(
        { permissions: { web: ["viewer", "superuser"] } } as never,
        "web",
        "superuser" as never,
      ),
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
