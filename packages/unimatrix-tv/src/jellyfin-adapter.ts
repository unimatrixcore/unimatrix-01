import type { BootGate } from './loading-gate.js';

const ASSETS = '/UnimatrixTV/assets/';
const REQUESTS = 'https://requests.unimatrix-01.dev/';

function isPlayback(): boolean {
  if (typeof location !== 'undefined') {
    const hash = location.hash.toLowerCase();
    if (hash.includes('video') || hash.includes('playback')) return true;
  }
  if (typeof document !== 'undefined') {
    return Boolean(
      document.querySelector('video') ||
      document.querySelector('.videoPlayerContainer') ||
      document.querySelector('#videoPlayerPage') ||
      document.querySelector('.nowPlayingBar')
    );
  }
  return false;
}

function iconRequest(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2M12 7v10M7 12h10');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  svg.append(path);
  return svg;
}

export function installJellyfinAdapter(gate: BootGate): void {
  // If video playback is detected right at startup, immediately ensure gate is dismissed.
  if (isPlayback()) {
    gate.ready();
  }

  function ensureRequestsButton(): void {
    const row = document.querySelector<HTMLElement>('header.MuiAppBar-root .MuiToolbar-root, .skinHeader .headerTop');
    if (!row || row.querySelector('.utv-header-requests')) return;

    const utility = document.createElement('a');
    utility.className = 'utv-header-requests';
    utility.href = REQUESTS;
    utility.target = '_blank';
    utility.rel = 'noopener';
    utility.title = 'Requests';
    utility.setAttribute('aria-label', 'Open Unimatrix-TV Requests');
    utility.dataset.utvOwned = 'true';
    utility.append(iconRequest());

    const tools = Array.from(row.children).find(node =>
      node.querySelector('a[aria-label="Search"], button[aria-label="Search"], button[aria-label="User Menu"]')
    );
    if (tools) {
      row.insertBefore(utility, tools);
    } else {
      row.append(utility);
    }
  }

  function enhanceLoginPage(): void {
    const page = document.querySelector<HTMLElement>('#loginPage:not(.hide)');
    if (!page) return;

    if (!page.querySelector('#utv-login-scene')) {
      const aside = document.createElement('aside');
      aside.id = 'utv-login-scene';
      aside.dataset.utvOwned = 'true';
      const logo = document.createElement('img');
      logo.src = ASSETS + 'logo.png';
      logo.alt = 'Unimatrix-TV';
      const heading = document.createElement('h2');
      heading.textContent = 'Unimatrix-TV';
      aside.append(logo, heading);
      page.prepend(aside);
    }

    const disclaimer = page.querySelector<HTMLElement>('.loginDisclaimer');
    if (disclaimer && !disclaimer.dataset.utvSimple) {
      disclaimer.dataset.utvSimple = 'true';
      const reqLink = document.createElement('a');
      reqLink.href = REQUESTS;
      reqLink.target = '_blank';
      reqLink.rel = 'noopener';
      reqLink.textContent = 'Unimatrix-TV Requests ↗';
      disclaimer.replaceChildren(reqLink);
    }
  }

  function fixServerIdLinks(): void {
    const clientVal = (window as Window & { ApiClient?: { serverId?: () => string } }).ApiClient;
    const server = typeof clientVal?.serverId === 'function' ? clientVal.serverId() : undefined;
    if (!server || server === 'undefined') return;

    for (const node of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="serverId=undefined"]'))) {
      const href = node.getAttribute('href');
      if (href) {
        node.setAttribute('href', href.replace('serverId=undefined', 'serverId=' + encodeURIComponent(server)));
      }
    }
  }

  function sync(): void {
    if (isPlayback()) {
      gate.ready();
      return;
    }

    const isLogin = Boolean(document.querySelector('#loginPage:not(.hide)'));
    document.body?.classList.toggle('utv-login-active', isLogin);

    ensureRequestsButton();
    if (isLogin) {
      enhanceLoginPage();
    }
    fixServerIdLinks();
  }

  function onInitialReady(): void {
    gate.ready();
    sync();
  }

  // Dismiss boot gate immediately when play begins
  document.addEventListener('play', () => {
    gate.ready();
  }, true);

  // Sync on navigation events
  window.addEventListener('hashchange', () => {
    if (isPlayback()) {
      gate.ready();
    } else {
      sync();
    }
  });

  document.addEventListener('viewshow', sync);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onInitialReady();
  } else {
    document.addEventListener('DOMContentLoaded', onInitialReady, { once: true });
  }

  // Lightweight observer only looking for top-level mounting of header / page changes
  const observer = new MutationObserver(() => {
    if (isPlayback()) {
      gate.ready();
      return;
    }
    ensureRequestsButton();
  });

  const target = document.getElementById('reactRoot') ?? document.body;
  if (target) {
    observer.observe(target, { childList: true, subtree: false });
  }
}
