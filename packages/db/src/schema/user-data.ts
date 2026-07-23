import { sql } from "drizzle-orm";
import { blob, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const userDocumentsTable = sqliteTable(
  "user_documents",
  {
    userId: text("user_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.namespace, table.key],
    }),
  ],
);

export type NewUserDocument = typeof userDocumentsTable.$inferInsert;
export type UserDocument = typeof userDocumentsTable.$inferSelect;

export const userFilesTable = sqliteTable(
  "user_files",
  {
    userId: text("user_id").notNull(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    data: blob("data", { mode: "buffer" }).notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.namespace, table.key],
    }),
  ],
);

export type NewUserFile = typeof userFilesTable.$inferInsert;
export type UserFile = typeof userFilesTable.$inferSelect;
