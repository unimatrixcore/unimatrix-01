import type { UserStore } from "./types.js";
import { assertValidNamespace } from "./validation.js";

export type ConflictPolicy = "skip-existing" | "overwrite";

export interface MigrateGuestDataToAccountOptions {
  /** Defaults to `"skip-existing"`: never clobbers data already on the account. */
  conflictPolicy?: ConflictPolicy;
  /** Deletes migrated guest documents/files afterward. Defaults to `false`. */
  clearGuestAfter?: boolean;
}

export interface MigrateGuestDataToAccountArgs {
  /** Must match the namespace both `account` and `guest` were created with. */
  namespace: string;
  account: UserStore;
  guest: UserStore;
  options?: MigrateGuestDataToAccountOptions;
}

export interface MigrationSummary {
  documentsMigrated: number;
  documentsSkipped: number;
  filesMigrated: number;
  filesSkipped: number;
}

/**
 * Copies every guest document and file for `namespace` up to the account
 * store. Pure-ish over the two `UserStore` interfaces (no direct
 * IndexedDB/fetch access) so it is unit-testable against fakes. Default
 * conflict policy is `"skip-existing"` — a key already present on the
 * account is left untouched; pass `{ conflictPolicy: "overwrite" }` to
 * clobber it instead. Files without a readable blob on the guest side
 * (shouldn't normally happen) are counted as skipped rather than thrown.
 */
export async function migrateGuestDataToAccount(
  args: MigrateGuestDataToAccountArgs,
): Promise<MigrationSummary> {
  assertValidNamespace(args.namespace);

  if (args.account.mode !== "account") {
    throw new Error('migrateGuestDataToAccount: "account" store must have mode "account".');
  }

  if (args.guest.mode !== "guest") {
    throw new Error('migrateGuestDataToAccount: "guest" store must have mode "guest".');
  }

  const { account, guest } = args;
  const conflictPolicy = args.options?.conflictPolicy ?? "skip-existing";
  const clearGuestAfter = args.options?.clearGuestAfter ?? false;

  const summary: MigrationSummary = {
    documentsMigrated: 0,
    documentsSkipped: 0,
    filesMigrated: 0,
    filesSkipped: 0,
  };

  const guestDocuments = await guest.settings.list();
  const existingDocumentKeys =
    conflictPolicy === "skip-existing"
      ? new Set((await account.settings.list()).map((document) => document.key))
      : new Set<string>();

  for (const document of guestDocuments) {
    if (conflictPolicy === "skip-existing" && existingDocumentKeys.has(document.key)) {
      summary.documentsSkipped += 1;
      continue;
    }

    await account.settings.set(document.key, document.value);
    summary.documentsMigrated += 1;
  }

  const guestFiles = await guest.files.list();
  const existingFileKeys =
    conflictPolicy === "skip-existing"
      ? new Set((await account.files.list()).map((file) => file.key))
      : new Set<string>();

  for (const file of guestFiles) {
    if (conflictPolicy === "skip-existing" && existingFileKeys.has(file.key)) {
      summary.filesSkipped += 1;
      continue;
    }

    const blob = await guest.files.getBlob(file.key);

    if (!blob) {
      summary.filesSkipped += 1;
      continue;
    }

    await account.files.upload(file.key, blob, { contentType: file.contentType });
    summary.filesMigrated += 1;
  }

  if (clearGuestAfter) {
    for (const document of guestDocuments) {
      await guest.settings.delete(document.key);
    }

    for (const file of guestFiles) {
      await guest.files.delete(file.key);
    }
  }

  return summary;
}
