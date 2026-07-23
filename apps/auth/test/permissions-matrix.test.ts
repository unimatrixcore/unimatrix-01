import { describe, expect, it } from "vitest";

import type { PermissionsMap } from "@unimatrix/shared";

import {
  hasMatrixPermission,
  toggleMatrixPermission,
} from "../src/features/admin/permissions-matrix.js";

describe("permissions matrix helpers", () => {
  it("reports whether a permissions map grants a role", () => {
    expect(hasMatrixPermission({}, "web", "viewer")).toBe(false);
    expect(hasMatrixPermission({ web: ["viewer"] }, "web", "viewer")).toBe(true);
    expect(hasMatrixPermission({ web: ["viewer"] }, "web", "editor")).toBe(false);
    expect(hasMatrixPermission({ web: ["viewer"] }, "auth", "viewer")).toBe(false);
  });

  it("adds a role immutably when it is not already present", () => {
    const original: PermissionsMap = { web: ["viewer"] };
    const next = toggleMatrixPermission(original, "web", "editor");

    expect(next).toEqual({ web: ["viewer", "editor"] });
    expect(original).toEqual({ web: ["viewer"] });
  });

  it("removes a role immutably when it is already present", () => {
    const original: PermissionsMap = { web: ["viewer", "editor"] };
    const next = toggleMatrixPermission(original, "web", "editor");

    expect(next).toEqual({ web: ["viewer"] });
    expect(original).toEqual({ web: ["viewer", "editor"] });
  });

  it("drops the app slug entirely once its last role is removed", () => {
    const next = toggleMatrixPermission({ web: ["viewer"] }, "web", "viewer");

    expect(next).toEqual({});
    expect(Object.hasOwn(next, "web")).toBe(false);
  });

  it("adds a new app slug entry when toggling a role for an absent app", () => {
    const next = toggleMatrixPermission({}, "auth", "admin");

    expect(next).toEqual({ auth: ["admin"] });
  });
});
