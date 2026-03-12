import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSqliteClient } from "./client.js";

const client = createSqliteClient({
  filePath: ":memory:",
});

try {
  const row = client.prepare("select 1 as value").get() as { value: number };

  if (row.value !== 1) {
    throw new Error("sqlite smoke test did not return the expected value");
  }

  console.log("@unimatrix/db smoke test passed");
} finally {
  client.close();
}

const tempDirectory = mkdtempSync(join(tmpdir(), "unimatrix-db-"));
const migrationDatabasePath = join(tempDirectory, "migration-test.sqlite");
const migrationClient = createSqliteClient({
  filePath: migrationDatabasePath,
});

try {
  const migrationSql = readFileSync(
    new URL("../drizzle/0000_round_molly_hayes.sql", import.meta.url),
    "utf8",
  );

  migrationClient.exec(migrationSql);

  const insertedRow = migrationClient
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

  migrationClient
    .prepare(
      `
        update system_settings
        set value = ?
        where key = ?
      `,
    )
    .run("Locutus", "site_name");

  const updatedRow = migrationClient
    .prepare(
      `
        select updated_at
        from system_settings
        where key = ?
      `,
    )
    .get("site_name") as { updated_at: string };

  if (updatedRow.updated_at === insertedRow.updated_at) {
    throw new Error("updated_at trigger did not update the timestamp");
  }

  console.log("@unimatrix/db migration smoke test passed");
} finally {
  migrationClient.close();
  rmSync(tempDirectory, {
    force: true,
    recursive: true,
  });
}