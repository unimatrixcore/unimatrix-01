import { describe, expect, it } from "vitest";

import { normalizePermissionsMetadata } from "../src/admin.js";

describe("normalizePermissionsMetadata", () => {
  it("returns the permissions map for well-formed publicMetadata", () => {
    expect(
      normalizePermissionsMetadata({ permissions: { web: ["viewer", "editor"] } }),
    ).toEqual({ web: ["viewer", "editor"] });
  });

  it("returns an empty map when publicMetadata is undefined", () => {
    expect(normalizePermissionsMetadata(undefined)).toEqual({});
  });

  it("returns an empty map when publicMetadata is null or not an object", () => {
    expect(normalizePermissionsMetadata(null)).toEqual({});
    expect(normalizePermissionsMetadata("nonsense")).toEqual({});
  });

  it("returns an empty map when permissions is missing", () => {
    expect(normalizePermissionsMetadata({})).toEqual({});
  });

  it("returns an empty map when permissions is malformed", () => {
    expect(normalizePermissionsMetadata({ permissions: "nope" })).toEqual({});
    expect(normalizePermissionsMetadata({ permissions: null })).toEqual({});
    expect(normalizePermissionsMetadata({ permissions: [] })).toEqual({});
  });

  it("drops app slug entries whose role list is malformed", () => {
    expect(
      normalizePermissionsMetadata({
        permissions: { web: ["viewer"], auth: "admin", api: [1, 2, 3] },
      }),
    ).toEqual({ web: ["viewer"] });
  });

  it("drops unknown app slug keys, keeping only known slugs", () => {
    // Unknown app slugs are dropped: the shared `permissionsMapSchema` used
    // for the /admin/users response rejects keys outside APP_SLUGS, so
    // passing one through would fail response serialization.
    expect(
      normalizePermissionsMetadata({ permissions: { unknown: ["admin"], web: ["viewer"] } }),
    ).toEqual({ web: ["viewer"] });
  });

  it("drops unknown role strings within an otherwise valid role list", () => {
    expect(
      normalizePermissionsMetadata({ permissions: { web: ["viewer", "superuser"] } }),
    ).toEqual({});
  });
});
