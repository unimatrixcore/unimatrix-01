import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createDatabase, type DatabaseInstance } from "@unimatrix/db";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import {
  deleteDocument,
  deleteFile,
  getDocument,
  getFile,
  listDocuments,
  listFiles,
  putDocument,
  putFile,
} from "../src/modules/user-data/store.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

function createMigratedInMemoryDatabase(): DatabaseInstance {
  const instance = createDatabase({ filePath: ":memory:" });

  migrate(instance.db, { migrationsFolder: MIGRATIONS_FOLDER });

  return instance;
}

void test("putDocument creates a document and getDocument reads it back", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const created = await putDocument(db, "user_1", "cube-trainer", "settings", { theme: "dark" });

    assert.deepEqual(created, {
      namespace: "cube-trainer",
      key: "settings",
      value: { theme: "dark" },
      updatedAt: created.updatedAt,
    });
    assert.match(created.updatedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);

    const fetched = await getDocument(db, "user_1", "cube-trainer", "settings");

    assert.deepEqual(fetched, created);
  } finally {
    client.close();
  }
});

void test("getDocument returns undefined when no document matches", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const fetched = await getDocument(db, "user_1", "cube-trainer", "missing");

    assert.equal(fetched, undefined);
  } finally {
    client.close();
  }
});

void test("putDocument upserts the same composite key, overwriting the value", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    await putDocument(db, "user_1", "cube-trainer", "settings", { theme: "dark" });
    const updated = await putDocument(db, "user_1", "cube-trainer", "settings", { theme: "light" });

    assert.deepEqual(updated.value, { theme: "light" });

    const fetched = await getDocument(db, "user_1", "cube-trainer", "settings");

    assert.deepEqual(fetched?.value, { theme: "light" });

    const all = await listDocuments(db, "user_1", "cube-trainer");

    assert.equal(all.length, 1);
  } finally {
    client.close();
  }
});

void test("putDocument round-trips arbitrary JSON value shapes", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const complexValue = { nested: { array: [1, "two", null, true] }, count: 3 };
    await putDocument(db, "user_1", "cube-trainer", "complex", complexValue);
    const fetched = await getDocument(db, "user_1", "cube-trainer", "complex");

    assert.deepEqual(fetched?.value, complexValue);
  } finally {
    client.close();
  }
});

void test("listDocuments only returns documents for the given user and namespace", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    await putDocument(db, "user_1", "cube-trainer", "a", 1);
    await putDocument(db, "user_1", "cube-trainer", "b", 2);
    await putDocument(db, "user_1", "other-namespace", "c", 3);
    await putDocument(db, "user_2", "cube-trainer", "d", 4);

    const documents = await listDocuments(db, "user_1", "cube-trainer");

    assert.deepEqual(
      documents.map((document) => document.key).sort(),
      ["a", "b"],
    );
  } finally {
    client.close();
  }
});

void test("deleteDocument removes a document and reports whether it existed", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    await putDocument(db, "user_1", "cube-trainer", "settings", { theme: "dark" });

    const firstDelete = await deleteDocument(db, "user_1", "cube-trainer", "settings");
    assert.equal(firstDelete, true);

    const secondDelete = await deleteDocument(db, "user_1", "cube-trainer", "settings");
    assert.equal(secondDelete, false);

    const fetched = await getDocument(db, "user_1", "cube-trainer", "settings");
    assert.equal(fetched, undefined);
  } finally {
    client.close();
  }
});

void test("putFile stores a blob and getFile reads back matching bytes and metadata", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const data = Buffer.from("hello world", "utf8");
    const metadata = await putFile(db, "user_1", "cube-trainer", "avatar.png", "image/png", data.length, data);

    assert.deepEqual(metadata, {
      namespace: "cube-trainer",
      key: "avatar.png",
      contentType: "image/png",
      size: data.length,
      updatedAt: metadata.updatedAt,
    });

    const fetched = await getFile(db, "user_1", "cube-trainer", "avatar.png");

    assert.ok(fetched);
    assert.equal(Buffer.compare(fetched.data, data), 0);
    assert.equal(fetched.contentType, "image/png");
    assert.equal(fetched.size, data.length);
  } finally {
    client.close();
  }
});

void test("getFile returns undefined when no file matches", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const fetched = await getFile(db, "user_1", "cube-trainer", "missing.png");

    assert.equal(fetched, undefined);
  } finally {
    client.close();
  }
});

void test("putFile upserts the same composite key, overwriting bytes and content type", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const first = Buffer.from("first", "utf8");
    const second = Buffer.from("second-longer", "utf8");

    await putFile(db, "user_1", "cube-trainer", "avatar.png", "image/png", first.length, first);
    await putFile(db, "user_1", "cube-trainer", "avatar.png", "image/jpeg", second.length, second);

    const fetched = await getFile(db, "user_1", "cube-trainer", "avatar.png");

    assert.ok(fetched);
    assert.equal(Buffer.compare(fetched.data, second), 0);
    assert.equal(fetched.contentType, "image/jpeg");
    assert.equal(fetched.size, second.length);

    const all = await listFiles(db, "user_1", "cube-trainer");
    assert.equal(all.length, 1);
  } finally {
    client.close();
  }
});

void test("listFiles returns metadata only, never the blob, scoped to user and namespace", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const dataA = Buffer.from("aaa", "utf8");
    const dataB = Buffer.from("bbbb", "utf8");

    await putFile(db, "user_1", "cube-trainer", "a.txt", "text/plain", dataA.length, dataA);
    await putFile(db, "user_1", "cube-trainer", "b.txt", "text/plain", dataB.length, dataB);
    await putFile(db, "user_1", "other-namespace", "c.txt", "text/plain", dataA.length, dataA);
    await putFile(db, "user_2", "cube-trainer", "d.txt", "text/plain", dataA.length, dataA);

    const files = await listFiles(db, "user_1", "cube-trainer");

    assert.equal(files.length, 2);
    for (const file of files) {
      assert.equal("data" in file, false);
    }
    assert.deepEqual(
      files.map((file) => file.key).sort(),
      ["a.txt", "b.txt"],
    );
  } finally {
    client.close();
  }
});

void test("deleteFile removes a file and reports whether it existed", async () => {
  const { client, db } = createMigratedInMemoryDatabase();

  try {
    const data = Buffer.from("hello", "utf8");
    await putFile(db, "user_1", "cube-trainer", "avatar.png", "image/png", data.length, data);

    const firstDelete = await deleteFile(db, "user_1", "cube-trainer", "avatar.png");
    assert.equal(firstDelete, true);

    const secondDelete = await deleteFile(db, "user_1", "cube-trainer", "avatar.png");
    assert.equal(secondDelete, false);

    const fetched = await getFile(db, "user_1", "cube-trainer", "avatar.png");
    assert.equal(fetched, undefined);
  } finally {
    client.close();
  }
});
