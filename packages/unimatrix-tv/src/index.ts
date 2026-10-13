import { createBootGate } from './loading-gate.js';
import { installJellyfinAdapter } from './jellyfin-adapter.js';

export { createBootGate, type BootGate, type BootGateOptions } from './loading-gate.js';
export { installJellyfinAdapter } from './jellyfin-adapter.js';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const gate = createBootGate();
  installJellyfinAdapter(gate);
}
