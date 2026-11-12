import { invoke } from "@tauri-apps/api/core";

import type { InvokeTransport } from "./index";

export const tauriTransport: InvokeTransport = (command, args) => invoke(command, args);
