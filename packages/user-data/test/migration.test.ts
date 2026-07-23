import type { UserFileMetadata } from "@unimatrix/shared";
import { describe, expect, it } from "vitest";

import { migrateGuestDataToAccount } from "../src/migration.js";
import type { UserFilesStore, UserSettingsStore, UserStore } from "../src/types.js";

interface FakeDocumentRecord {
  key: string;
  value: unknown;
}

interface FakeFileRecord {
  metadata: UserFileMetadata;
  blob: Blob;
}

function createFakeStore(mode: "account" | "guest"): {
  store: UserStore;
  documents: Map<string, FakeDocumentRecord>;
  files: Map<string, FakeFileRecord>;
} {
  const documents = new Map<string, FakeDocumentRecord>();
  const files = new Map<string, FakeFileRecord>();

  const settings: UserSettingsStore = {
    get: <T>(key: string) => Promise.resolve(documents.get(key)?.value as T | undefined),
    set: (key: string, value: unknown) => {
      documents.set(key, { key, value });
      return Promise.resolve();
    },
    delete: (key: string) => {
      documents.delete(key);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...documents.values()].map((doc) => ({ key: doc.key, value: doc.value }))),
  };

  const filesStore: UserFilesStore = {
    upload: (key: string, file: Blob, options) => {
      const metadata: UserFileMetadata = {
        namespace: "test-ns",
        key,
        contentType: options?.contentType ?? file.type,
        size: file.size,
        updatedAt: new Date().toISOString(),
      };
      files.set(key, { metadata, blob: file });
      return Promise.resolve(metadata);
    },
    getBlob: (key: string) => Promise.resolve(files.get(key)?.blob),
    getObjectUrl: () => Promise.resolve(undefined),
    list: () => Promise.resolve([...files.values()].map((f) => f.metadata)),
    delete: (key: string) => {
      files.delete(key);
      return Promise.resolve();
    },
  };

  return { store: { mode, settings, files: filesStore }, documents, files };
}

describe("migrateGuestDataToAccount", () => {
  it("copies guest documents and files to an empty account", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await guest.store.settings.set("progress", { streak: 3 });
    await guest.store.files.upload("avatar.png", new Blob(["hello"], { type: "image/png" }));

    const summary = await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
    });

    expect(summary).toEqual({
      documentsMigrated: 1,
      documentsSkipped: 0,
      filesMigrated: 1,
      filesSkipped: 0,
    });
    await expect(account.store.settings.get("progress")).resolves.toEqual({ streak: 3 });
    const migratedFiles = await account.store.files.list();
    expect(migratedFiles).toHaveLength(1);
    expect(migratedFiles[0]?.key).toBe("avatar.png");
  });

  it("skips existing account documents/files by default (skip-existing)", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await account.store.settings.set("progress", { streak: 100 });
    await guest.store.settings.set("progress", { streak: 3 });
    await guest.store.settings.set("other", { value: 1 });

    await account.store.files.upload("avatar.png", new Blob(["existing"], { type: "image/png" }));
    await guest.store.files.upload("avatar.png", new Blob(["new"], { type: "image/png" }));
    await guest.store.files.upload("second.png", new Blob(["second"], { type: "image/png" }));

    const summary = await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
    });

    expect(summary).toEqual({
      documentsMigrated: 1,
      documentsSkipped: 1,
      filesMigrated: 1,
      filesSkipped: 1,
    });
    // Existing account data was not clobbered.
    await expect(account.store.settings.get("progress")).resolves.toEqual({ streak: 100 });
    await expect(account.store.settings.get("other")).resolves.toEqual({ value: 1 });
  });

  it("overwrites existing account data when conflictPolicy is 'overwrite'", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await account.store.settings.set("progress", { streak: 100 });
    await guest.store.settings.set("progress", { streak: 3 });

    const summary = await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
      options: { conflictPolicy: "overwrite" },
    });

    expect(summary.documentsMigrated).toBe(1);
    expect(summary.documentsSkipped).toBe(0);
    await expect(account.store.settings.get("progress")).resolves.toEqual({ streak: 3 });
  });

  it("clears guest data after migration when clearGuestAfter is true", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await guest.store.settings.set("progress", { streak: 3 });
    await guest.store.files.upload("avatar.png", new Blob(["hello"], { type: "image/png" }));

    await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
      options: { clearGuestAfter: true },
    });

    await expect(guest.store.settings.list()).resolves.toEqual([]);
    await expect(guest.store.files.list()).resolves.toEqual([]);
  });

  it("preserves skipped guest data when clearGuestAfter is true (skip-existing)", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    // Account already holds "progress" — it will be skipped, not migrated.
    await account.store.settings.set("progress", { streak: 99 });
    await guest.store.settings.set("progress", { streak: 3 });
    await guest.store.settings.set("nickname", "gwen");

    const summary = await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
      options: { clearGuestAfter: true },
    });

    expect(summary).toMatchObject({ documentsMigrated: 1, documentsSkipped: 1 });
    // Migrated key cleared; skipped key's guest copy must survive.
    await expect(guest.store.settings.list()).resolves.toEqual([
      { key: "progress", value: { streak: 3 } },
    ]);
    // Account keeps its own pre-existing value (never clobbered).
    await expect(account.store.settings.get("progress")).resolves.toEqual({ streak: 99 });
  });

  it("leaves guest data intact when clearGuestAfter is not set (default false)", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await guest.store.settings.set("progress", { streak: 3 });

    await migrateGuestDataToAccount({
      namespace: "test-ns",
      account: account.store,
      guest: guest.store,
    });

    await expect(guest.store.settings.list()).resolves.toEqual([{ key: "progress", value: { streak: 3 } }]);
  });

  it("throws when account/guest store modes are swapped", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await expect(
      migrateGuestDataToAccount({
        namespace: "test-ns",
        account: guest.store,
        guest: account.store,
      }),
    ).rejects.toThrow(/mode "account"/);
  });

  it("throws for an invalid namespace", async () => {
    const account = createFakeStore("account");
    const guest = createFakeStore("guest");

    await expect(
      migrateGuestDataToAccount({
        namespace: "Not Valid",
        account: account.store,
        guest: guest.store,
      }),
    ).rejects.toThrow();
  });
});
