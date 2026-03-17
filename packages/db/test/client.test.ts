import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { createSqliteClient } from "../src/client.js";

describe("@unimatrix/db baseline", () => {
  it("executes a basic query against an in-memory sqlite client", () => {
    const client = createSqliteClient({
      filePath: ":memory:",
    });

    try {
      const row = client.prepare("select 1 as value").get() as { value: number };

      expect(row.value).toBe(1);
    } finally {
      client.close();
    }
  });

  it("migration sql creates the expected table shape", () => {
    const client = createSqliteClient({
      filePath: ":memory:",
    });

    try {
      client.exec(
        readFileSync(
          new URL("../drizzle/0000_round_molly_hayes.sql", import.meta.url),
          "utf8",
        ),
      );

      const columns = client
        .prepare("pragma table_info('system_settings')")
        .all() as Array<{ name: string }>;

      expect(columns.map((column) => column.name)).toEqual([
        "key",
        "value",
        "description",
        "created_at",
        "updated_at",
      ]);
    } finally {
      client.close();
    }
  });

  it("updates updated_at after a row modification", async () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), "unimatrix-db-"));
    const filePath = join(tempDirectory, "migration-test.sqlite");
    const client = createSqliteClient({
      filePath,
    });

    try {
      client.exec(
        readFileSync(
          new URL("../drizzle/0000_round_molly_hayes.sql", import.meta.url),
          "utf8",
        ),
      );

      const insertedRow = client
        .prepare(
          `
            insert into system_settings (key, value)
            values (?, ?)
            returning updated_at
          `,
        )
        .get("site_name", "Unimatrix") as { updated_at: string };

      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });

      client
        .prepare(
          `
            update system_settings
            set value = ?
            where key = ?
          `,
        )
        .run("Locutus", "site_name");

      const updatedRow = client
        .prepare(
          `
            select updated_at
            from system_settings
            where key = ?
          `,
        )
        .get("site_name") as { updated_at: string };

      expect(updatedRow.updated_at).not.toBe(insertedRow.updated_at);
    } finally {
      client.close();
      rmSync(tempDirectory, {
        force: true,
        recursive: true,
      });
    }
  });
});
