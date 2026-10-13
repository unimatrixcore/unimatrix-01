export interface BootGate {
  begin(): void;
  ready(): void;
  fail(): void;
}

export interface BootGateOptions {
  logoUrl?: string;
  loadingText?: string;
  transitionMs?: number;
}

const DEFAULT_LOGO = '/UnimatrixTV/assets/logo.png';
const DEFAULT_TEXT = 'Loading your library';
const DEFAULT_TRANSITION_MS = 250;

export function createBootGate(options: BootGateOptions = {}): BootGate {
  const logoUrl = options.logoUrl ?? DEFAULT_LOGO;
  const loadingText = options.loadingText ?? DEFAULT_TEXT;
  const transitionMs = options.transitionMs ?? DEFAULT_TRANSITION_MS;

  let gateEl: HTMLElement | null = null;
  let isReady = false;
  let hasBooted = false;

  function isPlayback(): boolean {
    if (typeof location !== 'undefined' && (location.hash.toLowerCase().includes('video') || location.hash.toLowerCase().includes('playback'))) {
      return true;
    }
    if (typeof document !== 'undefined') {
      return Boolean(
        document.querySelector('video') ||
        document.querySelector('.videoPlayerContainer') ||
        document.querySelector('#videoPlayerPage') ||
        document.querySelector('[data-type="video"]')
      );
    }
    return false;
  }

  function ensureGate(): HTMLElement {
    if (gateEl && document.contains(gateEl)) {
      return gateEl;
    }

    const existing = document.getElementById('utv-boot-gate');
    if (existing) {
      gateEl = existing;
      return gateEl;
    }

    const gate = document.createElement('div');
    gate.id = 'utv-boot-gate';
    gate.setAttribute('role', 'status');
    gate.setAttribute('aria-live', 'polite');
    gate.setAttribute('aria-label', loadingText);

    const card = document.createElement('div');
    card.className = 'utv-boot-card';

    const logo = document.createElement('img');
    logo.className = 'utv-boot-logo';
    logo.src = logoUrl;
    logo.alt = 'Unimatrix-TV';

    const spinner = document.createElement('div');
    spinner.className = 'utv-boot-spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    text.className = 'utv-boot-text';
    text.textContent = loadingText;

    card.append(logo, spinner, text);
    gate.append(card);

    if (document.body) {
      document.body.prepend(gate);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (!isReady && !document.getElementById('utv-boot-gate')) {
          document.body?.prepend(gate);
        }
      });
    }

    gateEl = gate;
    return gate;
  }

  function dismiss(): void {
    isReady = true;
    document.documentElement.classList.remove('utv-boot-pending');

    const gate = gateEl ?? document.getElementById('utv-boot-gate');
    if (!gate) return;

    gate.style.transition = `opacity ${transitionMs}ms ease-out`;
    gate.style.opacity = '0';
    gate.style.pointerEvents = 'none';

    setTimeout(() => {
      gate.remove();
      if (gateEl === gate) gateEl = null;
    }, transitionMs);
  }

  return {
    begin(): void {
      if (hasBooted || isPlayback()) {
        dismiss();
        return;
      }
      isReady = false;
      document.documentElement.classList.add('utv-boot-pending');
      ensureGate();
    },
    ready(): void {
      hasBooted = true;
      dismiss();
    },
    fail(): void {
      hasBooted = true;
      dismiss();
    },
  };
}
