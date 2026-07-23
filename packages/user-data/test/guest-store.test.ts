import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";

import { createGuestUserStore } from "../src/guest-store.js";

function uniqueNamespace(): string {
  return `guest-test-${Math.random().toString(36).slice(2, 10)}`;
}

describe("createGuestUserStore", () => {
  it("throws for an invalid namespace", () => {
    expect(() => createGuestUserStore({ namespace: "Not Valid!" })).toThrow();
  });

  it("round-trips a document via settings", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });

    await store.settings.set("progress", { streak: 5 });
    await expect(store.settings.get("progress")).resolves.toEqual({ streak: 5 });

    const list = await store.settings.list();
    expect(list).toEqual([{ key: "progress", value: { streak: 5 } }]);

    await store.settings.delete("progress");
    await expect(store.settings.get("progress")).resolves.toBeUndefined();
  });

  it("resolves undefined for a missing document", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });
    await expect(store.settings.get("missing")).resolves.toBeUndefined();
  });

  it("rejects an invalid key on get/set/delete", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });

    await expect(store.settings.get("bad key!")).rejects.toThrow();
    await expect(store.settings.set("bad key!", 1)).rejects.toThrow();
    await expect(store.settings.delete("bad key!")).rejects.toThrow();
  });

  it("round-trips a Blob via files", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });
    const blob = new Blob(["hello world"], { type: "text/plain" });

    const metadata = await store.files.upload("note.txt", blob);
    expect(metadata.contentType).toBe("text/plain");
    expect(metadata.size).toBe(blob.size);
    expect(metadata.key).toBe("note.txt");

    const storedBlob = await store.files.getBlob("note.txt");
    expect(storedBlob).toBeDefined();
    expect(storedBlob?.size).toBe(blob.size);
    expect(storedBlob?.type).toBe("text/plain");
    await expect(storedBlob?.text()).resolves.toBe("hello world");

    const list = await store.files.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe("note.txt");

    await store.files.delete("note.txt");
    await expect(store.files.getBlob("note.txt")).resolves.toBeUndefined();
  });

  it("resolves undefined for a missing file", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });
    await expect(store.files.getBlob("missing.png")).resolves.toBeUndefined();
    await expect(store.files.getObjectUrl("missing.png")).resolves.toBeUndefined();
  });

  it("keeps documents/files scoped to their own namespace", async () => {
    const namespaceA = uniqueNamespace();
    const namespaceB = uniqueNamespace();
    const storeA = createGuestUserStore({ namespace: namespaceA });
    const storeB = createGuestUserStore({ namespace: namespaceB });

    await storeA.settings.set("shared-key", { from: "a" });
    await storeB.settings.set("shared-key", { from: "b" });

    await expect(storeA.settings.get("shared-key")).resolves.toEqual({ from: "a" });
    await expect(storeB.settings.get("shared-key")).resolves.toEqual({ from: "b" });
  });

  it("uses account mode discriminant of guest for the store", () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });
    expect(store.mode).toBe("guest");
  });
});

describe("createGuestUserStore getObjectUrl", () => {
  beforeEach(() => {
    // URL.createObjectURL/revokeObjectURL aren't implemented by Node/jsdom by
    // default; stub a minimal version so getObjectUrl is exercised.
    if (typeof URL.createObjectURL !== "function") {
      let counter = 0;
      URL.createObjectURL = () => `blob:fake-${++counter}`;
    }
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = () => undefined;
    }
  });

  it("returns an object URL for an existing blob", async () => {
    const store = createGuestUserStore({ namespace: uniqueNamespace() });
    await store.files.upload("note.txt", new Blob(["hi"], { type: "text/plain" }));

    const url = await store.files.getObjectUrl("note.txt");
    expect(url).toMatch(/^blob:/);
  });
});
