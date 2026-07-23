import { describe, expect, it } from "vitest";

import {
  dataKeySchema,
  dataNamespaceSchema,
  deleteDocumentBodySchema,
  deleteDocumentContract,
  deleteFileBodySchema,
  deleteFileContract,
  deleteResultSchema,
  getDocumentContract,
  getDocumentQuerySchema,
  listDocumentsContract,
  listDocumentsQuerySchema,
  listDocumentsResponseSchema,
  listFilesContract,
  listFilesQuerySchema,
  listFilesResponseSchema,
  putDocumentBodySchema,
  putDocumentContract,
  userDocumentSchema,
  userFileMetadataSchema,
} from "../src/index.js";

describe("dataNamespaceSchema", () => {
  it("accepts a lowercase hyphenated slug", () => {
    expect(dataNamespaceSchema.parse("cube-trainer")).toBe("cube-trainer");
  });

  it("accepts a single character slug", () => {
    expect(dataNamespaceSchema.parse("a")).toBe("a");
  });

  it("rejects uppercase characters", () => {
    expect(dataNamespaceSchema.safeParse("Cube-Trainer").success).toBe(false);
  });

  it("rejects a leading hyphen", () => {
    expect(dataNamespaceSchema.safeParse("-cube-trainer").success).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(dataNamespaceSchema.safeParse("").success).toBe(false);
  });

  it("rejects a slug longer than 64 characters", () => {
    expect(dataNamespaceSchema.safeParse("a".repeat(65)).success).toBe(false);
  });

  it("accepts a slug at the 64 character boundary", () => {
    expect(dataNamespaceSchema.safeParse("a".repeat(64)).success).toBe(true);
  });
});

describe("dataKeySchema", () => {
  it("accepts alphanumerics, dots, underscores, and hyphens", () => {
    expect(dataKeySchema.parse("settings.v1_final-2")).toBe("settings.v1_final-2");
  });

  it("rejects an empty string", () => {
    expect(dataKeySchema.safeParse("").success).toBe(false);
  });

  it("rejects a key longer than 128 characters", () => {
    expect(dataKeySchema.safeParse("a".repeat(129)).success).toBe(false);
  });

  it("accepts a key at the 128 character boundary", () => {
    expect(dataKeySchema.safeParse("a".repeat(128)).success).toBe(true);
  });

  it("rejects a slash", () => {
    expect(dataKeySchema.safeParse("nested/key").success).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(dataKeySchema.safeParse("has space").success).toBe(false);
  });
});

describe("userDocumentSchema", () => {
  const validDocument = {
    namespace: "cube-trainer",
    key: "settings",
    value: { theme: "dark" },
    updatedAt: "2026-07-22T00:00:00.000Z",
  };

  it("accepts a valid document with an arbitrary JSON value", () => {
    expect(userDocumentSchema.parse(validDocument)).toEqual(validDocument);
  });

  it("accepts primitive and array values", () => {
    expect(userDocumentSchema.parse({ ...validDocument, value: 42 }).value).toBe(42);
    expect(userDocumentSchema.parse({ ...validDocument, value: [1, 2, 3] }).value).toEqual([1, 2, 3]);
    expect(userDocumentSchema.parse({ ...validDocument, value: null }).value).toBeNull();
  });

  it("rejects an invalid namespace", () => {
    expect(userDocumentSchema.safeParse({ ...validDocument, namespace: "Bad Namespace" }).success).toBe(false);
  });

  it("rejects an invalid key", () => {
    expect(userDocumentSchema.safeParse({ ...validDocument, key: "" }).success).toBe(false);
  });

  it("rejects unexpected keys", () => {
    expect(userDocumentSchema.safeParse({ ...validDocument, extra: true }).success).toBe(false);
  });
});

describe("getDocumentQuerySchema", () => {
  it("requires namespace and key", () => {
    expect(getDocumentQuerySchema.parse({ namespace: "cube-trainer", key: "settings" })).toEqual({
      namespace: "cube-trainer",
      key: "settings",
    });
  });

  it("rejects a missing key", () => {
    expect(getDocumentQuerySchema.safeParse({ namespace: "cube-trainer" }).success).toBe(false);
  });
});

describe("putDocumentBodySchema", () => {
  it("accepts namespace, key, and an arbitrary value", () => {
    expect(
      putDocumentBodySchema.parse({
        namespace: "cube-trainer",
        key: "settings",
        value: { theme: "dark" },
      }),
    ).toEqual({
      namespace: "cube-trainer",
      key: "settings",
      value: { theme: "dark" },
    });
  });

  it("rejects an invalid namespace even when value is present", () => {
    expect(
      putDocumentBodySchema.safeParse({
        namespace: "Bad Namespace",
        key: "settings",
        value: { theme: "dark" },
      }).success,
    ).toBe(false);
  });

  it("rejects a missing key field", () => {
    expect(
      putDocumentBodySchema.safeParse({
        namespace: "cube-trainer",
        value: { theme: "dark" },
      }).success,
    ).toBe(false);
  });
});

describe("deleteDocumentBodySchema", () => {
  it("requires namespace and key", () => {
    expect(deleteDocumentBodySchema.parse({ namespace: "cube-trainer", key: "settings" })).toEqual({
      namespace: "cube-trainer",
      key: "settings",
    });
  });
});

describe("listDocumentsQuerySchema and listDocumentsResponseSchema", () => {
  it("requires a namespace on the query", () => {
    expect(listDocumentsQuerySchema.parse({ namespace: "cube-trainer" })).toEqual({
      namespace: "cube-trainer",
    });
    expect(listDocumentsQuerySchema.safeParse({}).success).toBe(false);
  });

  it("accepts a list of documents on the response", () => {
    const payload = {
      documents: [
        {
          namespace: "cube-trainer",
          key: "settings",
          value: { theme: "dark" },
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    };
    expect(listDocumentsResponseSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an empty documents list", () => {
    expect(listDocumentsResponseSchema.parse({ documents: [] })).toEqual({ documents: [] });
  });
});

describe("deleteResultSchema", () => {
  it("accepts a boolean deleted flag", () => {
    expect(deleteResultSchema.parse({ deleted: true })).toEqual({ deleted: true });
    expect(deleteResultSchema.parse({ deleted: false })).toEqual({ deleted: false });
  });

  it("rejects a non-boolean deleted flag", () => {
    expect(deleteResultSchema.safeParse({ deleted: "yes" }).success).toBe(false);
  });
});

describe("userFileMetadataSchema", () => {
  const validMetadata = {
    namespace: "cube-trainer",
    key: "avatar.png",
    contentType: "image/png",
    size: 1024,
    updatedAt: "2026-07-22T00:00:00.000Z",
  };

  it("accepts valid file metadata", () => {
    expect(userFileMetadataSchema.parse(validMetadata)).toEqual(validMetadata);
  });

  it("rejects a negative size", () => {
    expect(userFileMetadataSchema.safeParse({ ...validMetadata, size: -1 }).success).toBe(false);
  });

  it("rejects a non-integer size", () => {
    expect(userFileMetadataSchema.safeParse({ ...validMetadata, size: 1.5 }).success).toBe(false);
  });

  it("accepts a zero-byte size", () => {
    expect(userFileMetadataSchema.safeParse({ ...validMetadata, size: 0 }).success).toBe(true);
  });
});

describe("listFilesQuerySchema and listFilesResponseSchema", () => {
  it("requires a namespace on the query", () => {
    expect(listFilesQuerySchema.parse({ namespace: "cube-trainer" })).toEqual({
      namespace: "cube-trainer",
    });
    expect(listFilesQuerySchema.safeParse({}).success).toBe(false);
  });

  it("accepts a list of file metadata on the response", () => {
    const payload = {
      files: [
        {
          namespace: "cube-trainer",
          key: "avatar.png",
          contentType: "image/png",
          size: 1024,
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      ],
    };
    expect(listFilesResponseSchema.parse(payload)).toEqual(payload);
  });
});

describe("deleteFileBodySchema", () => {
  it("requires namespace and key", () => {
    expect(deleteFileBodySchema.parse({ namespace: "cube-trainer", key: "avatar.png" })).toEqual({
      namespace: "cube-trainer",
      key: "avatar.png",
    });
  });
});

describe("user-data contracts", () => {
  it("getDocumentContract keeps the expected method, path, and schemas", () => {
    expect(getDocumentContract).toMatchObject({ method: "GET", path: "/me/data" });
    expect(getDocumentContract.querySchema).toBe(getDocumentQuerySchema);
    expect(getDocumentContract.responseSchema).toBe(userDocumentSchema);
    expect(getDocumentContract.bodySchema).toBeUndefined();
  });

  it("putDocumentContract keeps the expected method, path, and schemas", () => {
    expect(putDocumentContract).toMatchObject({ method: "PUT", path: "/me/data" });
    expect(putDocumentContract.bodySchema).toBe(putDocumentBodySchema);
    expect(putDocumentContract.responseSchema).toBe(userDocumentSchema);
    expect(putDocumentContract.querySchema).toBeUndefined();
  });

  it("deleteDocumentContract keeps the expected method, path, and schemas", () => {
    expect(deleteDocumentContract).toMatchObject({ method: "DELETE", path: "/me/data" });
    expect(deleteDocumentContract.bodySchema).toBe(deleteDocumentBodySchema);
    expect(deleteDocumentContract.responseSchema).toBe(deleteResultSchema);
  });

  it("listDocumentsContract keeps the expected method, path, and schemas", () => {
    expect(listDocumentsContract).toMatchObject({ method: "GET", path: "/me/data/list" });
    expect(listDocumentsContract.querySchema).toBe(listDocumentsQuerySchema);
    expect(listDocumentsContract.responseSchema).toBe(listDocumentsResponseSchema);
  });

  it("listFilesContract keeps the expected method, path, and schemas", () => {
    expect(listFilesContract).toMatchObject({ method: "GET", path: "/me/files" });
    expect(listFilesContract.querySchema).toBe(listFilesQuerySchema);
    expect(listFilesContract.responseSchema).toBe(listFilesResponseSchema);
  });

  it("deleteFileContract keeps the expected method, path, and schemas", () => {
    expect(deleteFileContract).toMatchObject({ method: "DELETE", path: "/me/files" });
    expect(deleteFileContract.bodySchema).toBe(deleteFileBodySchema);
    expect(deleteFileContract.responseSchema).toBe(deleteResultSchema);
  });
});
