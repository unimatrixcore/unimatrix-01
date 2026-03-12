import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const DEFAULT_SQLITE_DATABASE_FILE_PATH = fileURLToPath(
  new URL("./local/unimatrix.sqlite", import.meta.url),
);

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/system-settings.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || DEFAULT_SQLITE_DATABASE_FILE_PATH,
  },
});