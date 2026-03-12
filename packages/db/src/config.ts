import { fileURLToPath } from "node:url";

const PACKAGE_ROOT_URL = new URL("../", import.meta.url);

export const DEFAULT_SQLITE_DATABASE_FILE_PATH = fileURLToPath(
  new URL("./local/unimatrix.sqlite", PACKAGE_ROOT_URL),
);

export interface DatabaseConfig {
  filePath: string;
}

export function resolveDatabaseConfig(
  overrides: Partial<DatabaseConfig> = {},
): DatabaseConfig {
  return {
    filePath:
      overrides.filePath ||
      process.env.DATABASE_URL ||
      DEFAULT_SQLITE_DATABASE_FILE_PATH,
  };
}