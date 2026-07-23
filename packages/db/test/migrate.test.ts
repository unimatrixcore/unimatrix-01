import { describe, expect, it } from "vitest";

import { createDatabase, migrateDatabase, userDocumentsTable } from "../src/index.ts";

describe("migrateDatabase", () => {
  it("applies the checked-in migrations to a fresh database", () => {
    const instance = createDatabase({ filePath: ":memory:" });

    try {
      migrateDatabase(instance);

      // The user_documents table only exists once migration 0001 has run;
      // a successful round-trip proves the schema was created.
      instance.db
        .insert(userDocumentsTable)
        .values({ userId: "u1", namespace: "web", key: "settings", value: '{"a":1}' })
        .run();

      const rows = instance.db.select().from(userDocumentsTable).all();

      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe('{"a":1}');
    } finally {
      instance.client.close();
    }
  });

  it("is idempotent when run twice", () => {
    const instance = createDatabase({ filePath: ":memory:" });

    try {
      migrateDatabase(instance);
      expect(() => {
        migrateDatabase(instance);
      }).not.toThrow();
    } finally {
      instance.client.close();
    }
  });
});
