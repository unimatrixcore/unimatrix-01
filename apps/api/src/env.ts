import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const API_ROOT_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function createApiLocalEnvError(apiRootDirectory: string, filePath: string, error: unknown): Error {
  const displayPath = relative(apiRootDirectory, filePath).replaceAll("\\", "/") || filePath;
  const message = error instanceof Error ? error.message : String(error);

  return new Error(`Failed to load API local env file ${displayPath}: ${message}`, {
    cause: error instanceof Error ? error : undefined,
  });
}

function validateApiLocalEnvFile(filePath: string): void {
  const fileContents = readFileSync(filePath);

  UTF8_DECODER.decode(fileContents);

  if (fileContents.includes(0)) {
    throw new Error("file must not contain NUL bytes.");
  }
}

function loadApiLocalEnvFile(apiRootDirectory: string, fileName: ".env" | ".env.local"): void {
  const filePath = resolve(apiRootDirectory, fileName);

  try {
    validateApiLocalEnvFile(filePath);
    process.loadEnvFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw createApiLocalEnvError(apiRootDirectory, filePath, error);
  }
}

export function loadApiLocalEnvFiles(apiRootDirectory = API_ROOT_DIRECTORY): void {
  loadApiLocalEnvFile(apiRootDirectory, ".env.local");
  loadApiLocalEnvFile(apiRootDirectory, ".env");
}
