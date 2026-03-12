import { defineConfig } from "drizzle-kit";

import { resolveDatabaseConfig } from "./src/config";

export default defineConfig({
  breakpoints: true,
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseConfig().filePath,
  },
});