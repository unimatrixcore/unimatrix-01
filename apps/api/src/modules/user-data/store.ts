import type { DatabaseInstance } from "@unimatrix/db";
import { userDocumentsTable, userFilesTable } from "@unimatrix/db";
import { and, eq, sql } from "drizzle-orm";

export type UserDataDb = DatabaseInstance["db"];

export interface StoredDocument {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface StoredFileMetadata {
  namespace: string;
  key: string;
  contentType: string;
  size: number;
  updatedAt: string;
}

export interface StoredFile extends StoredFileMetadata {
  data: Buffer;
}

function toStoredDocument(row: typeof userDocumentsTable.$inferSelect): StoredDocument {
  return {
    namespace: row.namespace,
    key: row.key,
    value: JSON.parse(row.value) as unknown,
    updatedAt: row.updatedAt,
  };
}

type FileMetadataRow = Pick<
  typeof userFilesTable.$inferSelect,
  "namespace" | "key" | "contentType" | "size" | "updatedAt"
>;

function toStoredFileMetadata(row: FileMetadataRow): StoredFileMetadata {
  return {
    namespace: row.namespace,
    key: row.key,
    contentType: row.contentType,
    size: row.size,
    updatedAt: row.updatedAt,
  };
}

export async function getDocument(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
): Promise<StoredDocument | undefined> {
  const rows = await db
    .select()
    .from(userDocumentsTable)
    .where(
      and(
        eq(userDocumentsTable.userId, userId),
        eq(userDocumentsTable.namespace, namespace),
        eq(userDocumentsTable.key, key),
      ),
    )
    .limit(1);

  const row = rows[0];

  return row === undefined ? undefined : toStoredDocument(row);
}

export async function putDocument(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
  value: unknown,
): Promise<StoredDocument> {
  const serializedValue = JSON.stringify(value);

  const rows = await db
    .insert(userDocumentsTable)
    .values({
      userId,
      namespace,
      key,
      value: serializedValue,
    })
    .onConflictDoUpdate({
      target: [userDocumentsTable.userId, userDocumentsTable.namespace, userDocumentsTable.key],
      set: {
        value: serializedValue,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning();

  const row = rows[0];

  if (row === undefined) {
    throw new Error("putDocument: upsert did not return a row.");
  }

  return toStoredDocument(row);
}

export async function deleteDocument(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
): Promise<boolean> {
  const rows = await db
    .delete(userDocumentsTable)
    .where(
      and(
        eq(userDocumentsTable.userId, userId),
        eq(userDocumentsTable.namespace, namespace),
        eq(userDocumentsTable.key, key),
      ),
    )
    .returning();

  return rows.length > 0;
}

export async function listDocuments(
  db: UserDataDb,
  userId: string,
  namespace: string,
): Promise<StoredDocument[]> {
  const rows = await db
    .select()
    .from(userDocumentsTable)
    .where(and(eq(userDocumentsTable.userId, userId), eq(userDocumentsTable.namespace, namespace)));

  return rows.map(toStoredDocument);
}

export async function putFile(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
  contentType: string,
  size: number,
  data: Buffer,
): Promise<StoredFileMetadata> {
  const rows = await db
    .insert(userFilesTable)
    .values({
      userId,
      namespace,
      key,
      contentType,
      size,
      data,
    })
    .onConflictDoUpdate({
      target: [userFilesTable.userId, userFilesTable.namespace, userFilesTable.key],
      set: {
        contentType,
        size,
        data,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    })
    .returning({
      namespace: userFilesTable.namespace,
      key: userFilesTable.key,
      contentType: userFilesTable.contentType,
      size: userFilesTable.size,
      updatedAt: userFilesTable.updatedAt,
    });

  const row = rows[0];

  if (row === undefined) {
    throw new Error("putFile: upsert did not return a row.");
  }

  return toStoredFileMetadata(row);
}

export async function getFile(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
): Promise<StoredFile | undefined> {
  const rows = await db
    .select()
    .from(userFilesTable)
    .where(
      and(
        eq(userFilesTable.userId, userId),
        eq(userFilesTable.namespace, namespace),
        eq(userFilesTable.key, key),
      ),
    )
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    return undefined;
  }

  return {
    ...toStoredFileMetadata(row),
    data: row.data,
  };
}

/** Metadata only — never selects the `data` blob column. */
export async function listFiles(
  db: UserDataDb,
  userId: string,
  namespace: string,
): Promise<StoredFileMetadata[]> {
  const rows = await db
    .select({
      namespace: userFilesTable.namespace,
      key: userFilesTable.key,
      contentType: userFilesTable.contentType,
      size: userFilesTable.size,
      updatedAt: userFilesTable.updatedAt,
    })
    .from(userFilesTable)
    .where(and(eq(userFilesTable.userId, userId), eq(userFilesTable.namespace, namespace)));

  return rows.map(toStoredFileMetadata);
}

export async function deleteFile(
  db: UserDataDb,
  userId: string,
  namespace: string,
  key: string,
): Promise<boolean> {
  const rows = await db
    .delete(userFilesTable)
    .where(
      and(
        eq(userFilesTable.userId, userId),
        eq(userFilesTable.namespace, namespace),
        eq(userFilesTable.key, key),
      ),
    )
    .returning();

  return rows.length > 0;
}
