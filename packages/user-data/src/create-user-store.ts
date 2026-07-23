import type { CreateAccountUserStoreOptions } from "./account-store.js";
import type { CreateGuestUserStoreOptions } from "./guest-store.js";
import type { UserStore } from "./types.js";

import { createAccountUserStore } from "./account-store.js";
import { createGuestUserStore } from "./guest-store.js";

export type CreateUserStoreOptions =
  | ({ mode: "account" } & CreateAccountUserStoreOptions)
  | ({ mode: "guest" } & CreateGuestUserStoreOptions);

/**
 * Single entry point that dispatches to {@link createAccountUserStore} or
 * {@link createGuestUserStore} based on `options.mode`. Prefer this over
 * calling the adapters directly when the caller already knows which mode
 * it wants (e.g. `./react`'s `useUserStore`).
 */
export function createUserStore(options: CreateUserStoreOptions): UserStore {
  if (options.mode === "account") {
    return createAccountUserStore(options);
  }

  return createGuestUserStore(options);
}
