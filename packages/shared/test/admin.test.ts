import { describe, expect, it } from "vitest";

import {
  listUsersContract,
  listUsersQuerySchema,
  listUsersResponseSchema,
  permissionsMapSchema,
  updateUserPermissionsBodySchema,
  updateUserPermissionsContract,
  updateUserPermissionsResponseSchema,
  userSummarySchema,
} from "../src/index.js";

describe("permissionsMapSchema", () => {
  it("accepts a partial map of app slugs to role lists", () => {
    expect(
      permissionsMapSchema.parse({
        web: ["viewer", "editor"],
        auth: ["admin"],
      }),
    ).toEqual({
      web: ["viewer", "editor"],
      auth: ["admin"],
    });
  });

  it("accepts an empty map", () => {
    expect(permissionsMapSchema.parse({})).toEqual({});
  });

  it("rejects unknown app slugs", () => {
    expect(permissionsMapSchema.safeParse({ unknown: ["viewer"] }).success).toBe(false);
  });

  it("rejects unknown roles", () => {
    expect(permissionsMapSchema.safeParse({ web: ["superuser"] }).success).toBe(false);
  });
});

describe("userSummarySchema", () => {
  const validUser = {
    id: "user_123",
    primaryEmailAddress: "person@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    username: "ada",
    imageUrl: "https://img.example.com/ada.png",
    permissions: { web: ["viewer"] },
  };

  it("accepts a fully populated user summary", () => {
    expect(userSummarySchema.parse(validUser)).toEqual(validUser);
  });

  it("accepts null for optional identity fields", () => {
    expect(
      userSummarySchema.parse({
        ...validUser,
        primaryEmailAddress: null,
        firstName: null,
        lastName: null,
        username: null,
        imageUrl: null,
      }).primaryEmailAddress,
    ).toBeNull();
  });

  it("rejects unexpected keys", () => {
    expect(userSummarySchema.safeParse({ ...validUser, extra: true }).success).toBe(false);
  });

  it("rejects a missing id", () => {
    const withoutId: Record<string, unknown> = { ...validUser };
    delete withoutId.id;
    expect(userSummarySchema.safeParse(withoutId).success).toBe(false);
  });
});

describe("listUsersQuerySchema", () => {
  it("defaults limit to 20 and offset to 0", () => {
    expect(listUsersQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  it("coerces string query parameters to numbers", () => {
    expect(listUsersQuerySchema.parse({ limit: "5", offset: "10" })).toEqual({
      limit: 5,
      offset: 10,
    });
  });

  it("accepts an optional query string", () => {
    expect(listUsersQuerySchema.parse({ query: "ada" })).toEqual({
      query: "ada",
      limit: 20,
      offset: 0,
    });
  });

  it("rejects a limit above 100", () => {
    expect(listUsersQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });

  it("rejects a limit below 1", () => {
    expect(listUsersQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("rejects a negative offset", () => {
    expect(listUsersQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });

  it("rejects non-integer limit/offset", () => {
    expect(listUsersQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
    expect(listUsersQuerySchema.safeParse({ offset: "1.5" }).success).toBe(false);
  });
});

describe("listUsersResponseSchema", () => {
  it("accepts a valid response payload", () => {
    const payload = {
      users: [],
      totalCount: 0,
      limit: 20,
      offset: 0,
    };
    expect(listUsersResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a negative totalCount", () => {
    expect(
      listUsersResponseSchema.safeParse({
        users: [],
        totalCount: -1,
        limit: 20,
        offset: 0,
      }).success,
    ).toBe(false);
  });
});

describe("updateUserPermissionsBodySchema", () => {
  it("accepts a userId and permissions map", () => {
    expect(
      updateUserPermissionsBodySchema.parse({
        userId: "user_123",
        permissions: { auth: ["admin"] },
      }),
    ).toEqual({
      userId: "user_123",
      permissions: { auth: ["admin"] },
    });
  });

  it("rejects an empty userId", () => {
    expect(
      updateUserPermissionsBodySchema.safeParse({
        userId: "",
        permissions: {},
      }).success,
    ).toBe(false);
  });

  it("rejects a missing permissions map", () => {
    expect(updateUserPermissionsBodySchema.safeParse({ userId: "user_123" }).success).toBe(false);
  });
});

describe("updateUserPermissionsResponseSchema", () => {
  it("is the same shape as userSummarySchema", () => {
    expect(updateUserPermissionsResponseSchema).toBe(userSummarySchema);
  });
});

describe("listUsersContract", () => {
  it("keeps the expected method, path, and schemas", () => {
    expect(listUsersContract).toMatchObject({
      method: "GET",
      path: "/admin/users",
    });
    expect(listUsersContract.querySchema).toBe(listUsersQuerySchema);
    expect(listUsersContract.responseSchema).toBe(listUsersResponseSchema);
    expect(listUsersContract.bodySchema).toBeUndefined();
  });
});

describe("updateUserPermissionsContract", () => {
  it("keeps the expected method, path, and schemas", () => {
    expect(updateUserPermissionsContract).toMatchObject({
      method: "PATCH",
      path: "/admin/users",
    });
    expect(updateUserPermissionsContract.bodySchema).toBe(updateUserPermissionsBodySchema);
    expect(updateUserPermissionsContract.responseSchema).toBe(updateUserPermissionsResponseSchema);
    expect(updateUserPermissionsContract.querySchema).toBeUndefined();
  });
});
