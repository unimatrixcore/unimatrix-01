// Installs an in-memory IndexedDB implementation as globals (`indexedDB`,
// `IDBKeyRange`, etc.) for every test file, since Node has no built-in
// IndexedDB. Harmless for tests that don't touch the guest (IndexedDB)
// adapter.
import "fake-indexeddb/auto";
