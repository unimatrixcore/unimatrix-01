import { z } from 'zod';
import type { BootGate } from './loading-gate.js';

const ASSETS = '/UnimatrixTV/assets/';
const REQUESTS = 'https://requests.unimatrix-01.dev/';
const itemSchema = z.object({
  Id: z.string().min(1), Name: z.string(), Type: z.string(),
  CollectionType: z.string().optional(), Path: z.string().optional(),
  Overview: z.string().optional(), Genres: z.array(z.string()).optional(),
  ProductionYear: z.number().optional(), RunTimeTicks: z.number().optional(),
  OfficialRating: z.string().optional(), MediaSources: z.array(z.unknown()).optional(),
  ImageTags: z.record(z.string(), z.string()).optional(), BackdropImageTags: z.array(z.string()).optional(),
  ParentBackdropItemId: z.string().optional(), ParentBackdropImageTags: z.array(z.string()).optional(),
  UserData: z.object({ PlaybackPositionTicks: z.number().optional() }).optional(),
  People: z.array(z.object({ Id: z.string(), Name: z.string(), Type: z.string() })).optional(),
});
const itemsSchema = z.object({ Items: z.array(itemSchema).default([]) });
type Item = z.infer<typeof itemSchema>;
type Query = Record<string, string | number | boolean>;
interface JellyfinClient {
  getCurrentUserId(): string | undefined;
  serverId(): string;
  getItems(user: string, query: Query): Promise<unknown>;
  getItem(user: string, id: string): Promise<unknown>;
  getUserViews(query: Query, user: string): Promise<unknown>;
  getImageUrl(id: string, options: Query): string;
}
const callable = <T extends (...args: never[]) => unknown>() => z.custom<T>(value => typeof value === 'function');
const clientSchema = z.object({
  getCurrentUserId: callable<JellyfinClient['getCurrentUserId']>(), serverId: callable<JellyfinClient['serverId']>(),
  getItems: callable<JellyfinClient['getItems']>(), getItem: callable<JellyfinClient['getItem']>(),
  getUserViews: callable<JellyfinClient['getUserViews']>(), getImageUrl: callable<JellyfinClient['getImageUrl']>(),
});
function client(): JellyfinClient | undefined {
  const value: unknown = (window as Window & { ApiClient?: unknown }).ApiClient;
  return clientSchema.safeParse(value).success ? value as JellyfinClient : undefined;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function owned<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = element(tag, className, text); node.dataset.utvOwned = 'true'; return node;
}
function link(text: string, href: string, className = ''): HTMLAnchorElement {
  const node = element('a', className, text); node.href = href; return node;
}
function visible(node: Element | null): node is HTMLElement {
  return node instanceof HTMLElement && !node.closest('.hide,[hidden],[aria-hidden="true"]') && node.getBoundingClientRect().height > 0;
}
function visiblePage(selector: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll(selector)).find(visible);
}
function icon(name: 'play' | 'request' | 'details'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', name === 'play' ? 'M8 5v14l11-7z' : name === 'request' ? 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2M12 7v10M7 12h10' : 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 10v7M12 7v1');
  path.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
  path.setAttribute('stroke', name === 'play' ? 'none' : 'currentColor'); path.setAttribute('stroke-width', '1.6');
  svg.append(path); return svg;
}
function itemHref(item: Item, api: JellyfinClient): string {
  const server = api.serverId();
  return '#/details?' + new URLSearchParams({ id: item.Id, ...(server && server !== 'undefined' ? { serverId: server } : {}) }).toString();
}
function route(): { path: string; params: URLSearchParams } {
  const [path = '/home', query = ''] = location.hash.replace(/^#!?/, '').split('?');
  return { path: path || '/home', params: new URLSearchParams(query) };
}
async function bounded<T>(work: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Jellyfin response timed out')); }, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function decode(url: string): Promise<void> {
  const image = new Image(); image.src = url;
  await bounded(image.decode(), 8000);
}

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

export function installJellyfinAdapter(gate: BootGate): void {
  let generation = 0, heroGeneration = 0, currentHero = 0;
  let heroItems: Item[] = [], homeUser = '', viewUser = '', imageUser = '';
  let homeWork = false, viewWork = false, imageWork = false, detailWork = false;
  let viewRoutes: Partial<Record<'movies' | 'tvshows', string>> = {};
  const images = new Map<string, Item | null>();
  const toolCleanup = new WeakMap<HTMLDetailsElement, () => void>();
  let observer: MutationObserver | undefined, observationTarget: Element | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let started = 0, settling = false, adaptationReady = false;

  function stop(): void {
    observer?.disconnect(); observer = undefined; observationTarget = undefined;
    clearTimeout(refreshTimer); clearTimeout(settleTimer); clearTimeout(deadline); settling = false;
  }
  function fail(stamp: number): void { if (stamp !== generation) return; stop(); gate.fail(); }
  function kick(): void { if (!settling) return; clearTimeout(refreshTimer); clearTimeout(settleTimer); refreshTimer = setTimeout(reconcile, 80); }
  function complete(stamp: number): void {
    if (stamp !== generation || !settling || !adaptationReady || homeWork || viewWork || imageWork || detailWork) return;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (stamp !== generation || !settling || !adaptationReady || homeWork || viewWork || imageWork || detailWork) return;
      const page = activePage();
      if (page?.querySelector('.loadingSpinner,.mdl-spinner.is-active,[aria-busy="true"]')) { kick(); return; }
      stop(); gate.ready();
    }, Math.max(500, 1000 - (Date.now() - started)));
  }
  function activePage(): HTMLElement | undefined {
    const current = route();
    if (current.path === '/home' || current.path === '/') return visiblePage('#homeTab');
    if (current.path === '/details') return visiblePage('#itemDetailPage');
    if (current.path.includes('login')) return visiblePage('#loginPage');
    return visiblePage('.mainAnimatedPages .page,.viewContainer .page,.page:not(.hide)');
  }
  function observe(): void {
    if (isPlayback()) {
      stop();
      gate.ready();
      return;
    }
    const page = activePage();
    const target = page ?? document.querySelector('#reactRoot,.mainAnimatedPages,.viewContainer');
    if (!target || target === observationTarget) return;
    observer?.disconnect(); observationTarget = target;
    observer = new MutationObserver(records => {
      if (isPlayback()) {
        stop();
        gate.ready();
        return;
      }
      const changed = records.some(record => {
        if (!(record.target instanceof Element) || record.target.closest('[data-utv-owned]')) return false;
        if (record.type === 'attributes') return record.oldValue !== record.target.getAttribute(record.attributeName ?? '');
        return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some(node => node instanceof Element && !node.matches('[data-utv-owned]') && !node.closest('[data-utv-owned]'));
      });
      if (changed) { adaptationReady = false; kick(); }
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-busy'], attributeOldValue: true });
  }
  function begin(): void {
    if (isPlayback()) {
      stop();
      gate.ready();
      return;
    }
    stop(); generation++; heroGeneration++; started = Date.now(); settling = true; adaptationReady = false;
    gate.begin(); document.body.classList.remove('utv-mobile-menu-open');
    const stamp = generation; deadline = setTimeout(() => { fail(stamp); }, 20000); observe(); reconcile();
  }
  function navigation(): boolean {
    const api = client(), bar = document.querySelector('header.MuiAppBar-root');
    const row = bar?.querySelector<HTMLElement>('.MuiToolbar-root'), stack = bar?.querySelector<HTMLElement>('.MuiStack-root') ?? row;
    if (!api?.getCurrentUserId() || !row || !stack) return false;
    const movieRoute = stack.querySelector<HTMLAnchorElement>('a[href*="#/movies"]')?.getAttribute('href') ?? viewRoutes.movies;
    const tvRoute = stack.querySelector<HTMLAnchorElement>('a[href*="#/tv"]')?.getAttribute('href') ?? viewRoutes.tvshows;
    if (!movieRoute && !tvRoute) return false;
    if (stack === row && !row.querySelector('.utv-mobile-brand')) {
      const brand = owned('a', 'utv-mobile-brand'); brand.href = '#/home';
      const logo = element('img'); logo.src = ASSETS + 'logo.png'; logo.alt = '';
      brand.append(logo, element('span', '', 'Unimatrix-TV')); row.querySelector('button[aria-label="Open Menu"]')?.insertAdjacentElement('afterend', brand);
    }
    let nav = stack.querySelector<HTMLElement>('.utv-main-nav');
    if (!nav) { nav = owned('nav', 'utv-main-nav'); nav.id = 'utv-main-navigation'; nav.setAttribute('aria-label', 'Main navigation'); stack.append(nav); }
    const entries: [string, string][] = [['Home', '#/home'], ...(movieRoute ? [['Movies', movieRoute] as [string, string]] : []), ...(tvRoute ? [['Series', tvRoute] as [string, string]] : []), ['Favorites', '#/home?tab=1'], ['Search', '#/search'], ['Requests ↗', REQUESTS]];
    const signature = JSON.stringify(entries);
    if (nav.dataset.signature !== signature) { nav.dataset.signature = signature; nav.replaceChildren(...entries.map(([text, href]) => { const node = link(text, href, href === REQUESTS ? 'utv-request-link' : ''); if (href === REQUESTS) { node.target = '_blank'; node.rel = 'noopener'; node.setAttribute('aria-label', 'Open Unimatrix-TV Requests'); } return node; })); }
    if (!row.querySelector('.utv-header-requests')) {
      const utility = owned('a', 'utv-header-requests'); utility.href = REQUESTS; utility.append(icon('request')); utility.target = '_blank'; utility.rel = 'noopener'; utility.title = 'Requests'; utility.setAttribute('aria-label', 'Open Unimatrix-TV Requests');
      const tools = Array.from(row.children).find(node => node.querySelector('a[aria-label="Search"]')); if (tools) row.insertBefore(utility, tools); else row.append(utility);
    }
    const menu = row.querySelector<HTMLButtonElement>('button[aria-label="Open Menu"]');
    if (menu && !menu.dataset.utvBound) {
      menu.dataset.utvBound = 'true'; menu.addEventListener('click', event => {
        if (!matchMedia('(max-width:600px)').matches) return;
        event.preventDefault(); event.stopImmediatePropagation(); const open = document.body.classList.toggle('utv-mobile-menu-open'); menu.setAttribute('aria-expanded', String(open)); if (open) nav?.querySelector<HTMLAnchorElement>('a')?.focus();
      }, true);
    }
    menu?.setAttribute('aria-controls', 'utv-main-navigation'); menu?.setAttribute('aria-expanded', String(document.body.classList.contains('utv-mobile-menu-open')));
    if (!nav.dataset.utvBound) { nav.dataset.utvBound = 'true'; nav.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a')) { document.body.classList.remove('utv-mobile-menu-open'); menu?.setAttribute('aria-expanded', 'false'); } }); }
    const current = route();
    for (const node of Array.from(nav.querySelectorAll('a'))) {
      const href = node.getAttribute('href') ?? ''; const active = href === '#/home' ? ['/home', '/'].includes(current.path) && current.params.get('tab') !== '1' : href === '#/home?tab=1' ? current.path === '/home' && current.params.get('tab') === '1' : href.startsWith('#/movies') ? current.path === '/movies' : href.startsWith('#/tv') ? current.path === '/tv' : href === '#/search' && current.path === '/search';
      if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
    }
    return true;
  }
  async function loadRoutes(): Promise<void> {
    const api = client(), user = api?.getCurrentUserId(); if (!api || !user || viewWork) return;
    const key = api.serverId() + ':' + user; if (key === viewUser) return;
    viewWork = true;
    try {
      const response = itemsSchema.parse(await bounded(api.getUserViews({}, user)));
      if (api.getCurrentUserId() !== user) return;
      viewRoutes = {};
      for (const item of response.Items) if (item.CollectionType === 'movies' || item.CollectionType === 'tvshows') viewRoutes[item.CollectionType] = '#/' + (item.CollectionType === 'movies' ? 'movies' : 'tv') + '?' + new URLSearchParams({ topParentId: item.Id, collectionType: item.CollectionType }).toString();
      viewUser = key;
    } catch { /* Native library links remain the fallback. */ }
    finally { viewWork = false; kick(); }
  }
  function shortcuts(): void {
    const nav = visiblePage('#homeTab')?.querySelector('.utv-library-shortcuts'), header = document.querySelector('header.MuiAppBar-root'); if (!nav || !header) return;
    const entries: [string, string][] = [];
    const targets = [['a[href*="#/movies"]', 'Movies'], ['a[href*="#/tv"]', 'Series'], ['a[href*="tab=1"]', 'Favorites'], ['a[href*="#/search"]', 'Search']] as const;
    for (const [selector, name] of targets) {
      const node = header.querySelector(selector);
      if (node instanceof HTMLAnchorElement) entries.push([name, node.href]);
    }
    const current = Array.from(nav.querySelectorAll('a')).map(node => [node.textContent, node.href]);
    if (JSON.stringify(current) !== JSON.stringify(entries)) nav.replaceChildren(...entries.map(([text, href]) => link(text, href)));
  }
  function login(): boolean {
    const page = visiblePage('#loginPage'); if (!page) return false;
    const heading = page.querySelector('.manualLoginForm h1'); if (heading && heading.textContent !== 'Sign in') heading.textContent = 'Sign in';
    const disclaimer = page.querySelector<HTMLElement>('.loginDisclaimer'); if (disclaimer && !disclaimer.dataset.utvSimple) { disclaimer.dataset.utvSimple = 'true'; disclaimer.replaceChildren(link('Unimatrix-TV Requests ↗', REQUESTS)); }
    if (!page.querySelector('#utv-login-scene')) {
      const aside = owned('aside'); aside.id = 'utv-login-scene'; const logo = element('img'); logo.src = ASSETS + 'logo.png'; logo.alt = 'Unimatrix-TV'; aside.append(logo, element('h2', '', 'Unimatrix-TV')); page.prepend(aside);
    }
    return !!page.querySelector('form,input');
  }
  function nativePlay(item: Item): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>('.card[data-id="' + CSS.escape(item.Id) + '"] [data-action="resume"],.card[data-id="' + CSS.escape(item.Id) + '"] [data-action="play"]')).find(node => !node.closest('.hide,[hidden]'));
  }
  async function renderHero(shell: HTMLElement, api: JellyfinClient, stamp: number): Promise<void> {
    const item = heroItems[currentHero]; if (!item) return;
    const rendering = ++heroGeneration, user = api.getCurrentUserId();
    const focused = shell.contains(document.activeElement) ? document.activeElement?.getAttribute('aria-label') : null;
    const previous = shell.querySelector('.utv-featured-art.is-loaded');
    const art = element('div', 'utv-featured-art'), copy = element('div', 'utv-featured-copy'), heading = element('h1', '', item.Name);
    copy.append(heading);
    if (item.ImageTags?.Logo) {
      const logo = element('img', 'utv-title-logo'); logo.alt = ''; logo.src = api.getImageUrl(item.Id, { type: 'Logo', maxWidth: 700, tag: item.ImageTags.Logo });
      logo.addEventListener('load', () => { heading.classList.add('utv-visually-hidden'); logo.classList.add('is-loaded'); }, { once: true }); copy.prepend(logo);
    }
    const meta = element('div', 'utv-meta');
    for (const value of [item.ProductionYear, item.Type === 'Series' ? 'Series' : item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) + ' min' : 'Movie', item.Genres?.[0], item.OfficialRating]) if (value !== undefined && value !== '') meta.append(element('span', '', String(value)));
    copy.append(meta); if (item.Overview) copy.append(element('p', 'utv-summary', item.Overview));
    const actions = element('div', 'utv-actions'), play = element('button', 'utv-action'), native = nativePlay(item); play.type = 'button';
    play.append(icon(native ? 'play' : 'details'), element('span', '', native ? item.UserData?.PlaybackPositionTicks ? 'Resume' : 'Play' : 'View title'));
    play.addEventListener('click', () => { const action = nativePlay(item); if (action) action.click(); else location.hash = itemHref(item, api).slice(1); });
    actions.append(play); if (native) actions.append(link('Details', itemHref(item, api), 'utv-action secondary')); copy.append(actions);
    const bottom = element('div', 'utv-featured-bottom'), controls = element('div', 'utv-featured-controls'), dots = element('div', 'utv-featured-tabs'); dots.setAttribute('role', 'group'); dots.setAttribute('aria-label', 'Featured titles');
    function choose(index: number): void { currentHero = (index + heroItems.length) % heroItems.length; void renderHero(shell, api, generation).catch(() => { fail(generation); }); }
    if (heroItems.length > 1) {
      for (const [text, step, label] of [['‹', -1, 'Previous featured title'], ['›', 1, 'Next featured title']] as const) { const button = element('button', '', text); button.type = 'button'; button.setAttribute('aria-label', label); button.addEventListener('click', () => { choose(currentHero + step); }); controls.append(button); }
      heroItems.forEach((title, index) => {
        const dot = element('button'); dot.type = 'button'; dot.setAttribute('aria-label', title.Name); dot.setAttribute('aria-pressed', String(index === currentHero)); dot.addEventListener('click', () => { choose(index); });
        dot.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); choose(event.key === 'Home' ? 0 : event.key === 'End' ? heroItems.length - 1 : currentHero + (event.key === 'ArrowRight' ? 1 : -1)); }); dots.append(dot);
      });
    }
    const hit = link('', itemHref(item, api), 'utv-featured-hit'); hit.setAttribute('aria-label', 'View ' + item.Name); hit.addEventListener('click', event => { if (Number(shell.dataset.utvSwipedUntil ?? 0) > Date.now()) event.preventDefault(); });
    bottom.append(dots, controls); shell.replaceChildren(...(previous ? [previous] : []), art, hit, copy, bottom);
    const imageId = item.BackdropImageTags?.length ? item.Id : item.ParentBackdropItemId, tag = item.BackdropImageTags?.[0] ?? item.ParentBackdropImageTags?.[0];
    if (imageId) { const url = api.getImageUrl(imageId, { type: 'Backdrop', index: 0, maxWidth: 1920, quality: 90, ...(tag ? { tag } : {}) }); await decode(url); art.style.backgroundImage = 'url(' + JSON.stringify(url) + ')'; }
    if (rendering !== heroGeneration || stamp !== generation || !shell.isConnected || api.getCurrentUserId() !== user) return;
    art.classList.add('is-loaded'); shell.dataset.ready = 'true'; adaptationReady = true; previous?.remove();
    if (focused) Array.from(shell.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === focused)?.focus({ preventScroll: true }); complete(stamp);
  }
  async function home(): Promise<void> {
    const page = visiblePage('#homeTab'), sections = page?.querySelector<HTMLElement>('.homeSectionsContainer,.sections'), api = client(), user = api?.getCurrentUserId();
    if (!page || !sections || !api || !user || homeWork) return;
    const existing = sections.querySelector<HTMLElement>('#utv-featured,#utv-empty');
    if (existing && homeUser === api.serverId() + ':' + user) { adaptationReady = existing.id === 'utv-empty' || existing.dataset.ready === 'true'; return; }
    homeWork = true; const stamp = generation;
    try {
      const response = itemsSchema.parse(await bounded(api.getItems(user, { Recursive: true, IncludeItemTypes: 'Movie,Series', IsVirtualItem: false, Limit: 12, SortBy: 'DateCreated', SortOrder: 'Descending', Fields: 'Overview,Genres,PrimaryImageAspectRatio,ParentId,ProductionYear,RunTimeTicks,OfficialRating,MediaSources,RecursiveItemCount', EnableImageTypes: 'Primary,Backdrop,Logo', ImageTypeLimit: 1 })));
      const candidates = response.Items.filter(item => item.Type === 'Series' || item.Type === 'Movie' && (item.MediaSources?.length || item.Path));
      const available = await bounded(Promise.all(candidates.map(async item => item.Type !== 'Series' ? item : itemsSchema.parse(await api.getItems(user, { ParentId: item.Id, Recursive: true, IncludeItemTypes: 'Episode', IsVirtualItem: false, Limit: 1 })).Items.length ? item : null)));
      if (stamp !== generation || !visible(page) || api.getCurrentUserId() !== user) return;
      heroItems = available.filter((item): item is Item => item !== null).slice(0, 8); currentHero = 0; homeUser = api.serverId() + ':' + user;
      sections.querySelectorAll('#utv-featured,#utv-empty,.utv-library-shortcuts,.utv-theme-footer,#utv-home-loading').forEach(node => { node.remove(); });
      const shell = owned('section'); shell.id = heroItems.length ? 'utv-featured' : 'utv-empty'; shell.setAttribute('aria-label', heroItems.length ? 'Featured available title' : 'Your library'); sections.prepend(shell);
      let touch: { x: number; y: number } | undefined;
      shell.addEventListener('pointerdown', event => { if (event.pointerType === 'touch' && event.target instanceof Element && !event.target.closest('button,a:not(.utv-featured-hit)')) touch = { x: event.clientX, y: event.clientY }; });
      shell.addEventListener('pointerup', event => { if (!touch) return; const dx = event.clientX - touch.x, dy = event.clientY - touch.y; touch = undefined; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && heroItems.length > 1) { shell.dataset.utvSwipedUntil = String(Date.now() + 600); currentHero = (currentHero + (dx < 0 ? 1 : -1) + heroItems.length) % heroItems.length; void renderHero(shell, api, generation).catch(() => { fail(generation); }); } });
      shell.addEventListener('pointercancel', () => { touch = undefined; });
      if (heroItems.length) await renderHero(shell, api, stamp); else { shell.append(element('h1', '', 'No available titles')); const requests = link('Requests ↗', REQUESTS, 'utv-action'); requests.target = '_blank'; requests.rel = 'noopener'; shell.append(requests); adaptationReady = true; }
      const nav = owned('nav', 'utv-library-shortcuts'); nav.setAttribute('aria-label', 'Browse your library'); shell.insertAdjacentElement('afterend', nav); shortcuts();
    } catch { fail(stamp); }
    finally { homeWork = false; kick(); }
  }
  function applyArt(card: HTMLElement, item: Item | null | undefined, api: JellyfinClient): void {
    const image = card.querySelector<HTMLElement>('.cardImageContainer'); if (!item || !image || !card.isConnected) return;
    const type = item.Type === 'Episode' && item.ImageTags?.Primary ? 'Primary' : item.ImageTags?.Primary && ['Movie', 'Series'].includes(item.Type) ? 'Primary' : item.BackdropImageTags?.length ? 'Backdrop' : item.ImageTags?.Thumb ? 'Thumb' : item.ImageTags?.Primary ? 'Primary' : undefined;
    if (!type) return;
    const tag = type === 'Backdrop' ? item.BackdropImageTags?.[0] : item.ImageTags?.[type];
    image.style.setProperty('--utv-shelf-art', 'url(' + JSON.stringify(api.getImageUrl(item.Id, { type, index: 0, maxWidth: 780, quality: 90, ...(tag ? { tag } : {}) })) + ')');
    card.dataset.utvArt = type === 'Primary' && item.Type !== 'Episode' ? 'portrait' : 'landscape';
  }
  function shelves(): void {
    const page = visiblePage('#homeTab'), api = client(), user = api?.getCurrentUserId(); if (!page || !api || !user) return;
    const key = api.serverId() + ':' + user; if (key !== imageUser) { imageUser = key; images.clear(); }
    for (const section of Array.from(page.querySelectorAll<HTMLElement>('.verticalSection'))) {
      const heading = section.querySelector('h2.sectionTitle'), text = heading?.textContent?.trim(); if (!heading) continue;
      if (text === 'Continue Watching') section.dataset.utvShelf = 'continue';
      if (text === 'Recently Added in Movies' || section.dataset.utvShelf === 'movies') { section.dataset.utvShelf = 'movies'; if (heading.textContent !== 'Movies') heading.textContent = 'Movies'; }
      if (text === 'Recently Added in TV Shows' || section.dataset.utvShelf === 'series') { section.dataset.utvShelf = 'series'; if (heading.textContent !== 'Series') heading.textContent = 'Series'; }
    }
    const cards = Array.from(page.querySelectorAll<HTMLElement>('.verticalSection .card[data-id]')).filter(card => ['Movie', 'Series', 'Episode'].includes(card.dataset.type ?? ''));
    const missing = new Set<string>();
    for (const card of cards) {
      card.classList.add('utv-stream-card'); if (!card.dataset.utvArt) card.dataset.utvArt = card.dataset.type === 'Episode' ? 'landscape' : 'portrait';
      if (card.dataset.type === 'Episode' && card.classList.contains('overflowPortraitCard')) { card.classList.replace('overflowPortraitCard', 'overflowBackdropCard'); card.querySelector('.cardPadder')?.classList.replace('cardPadder-overflowPortrait', 'cardPadder-overflowBackdrop'); }
      const id = card.dataset.id; if (!id) continue; if (images.has(id)) applyArt(card, images.get(id), api); else missing.add(id);
    }
    if (!missing.size || imageWork) return; imageWork = true; const stamp = generation;
    void bounded(api.getItems(user, { Ids: Array.from(missing).join(','), EnableImageTypes: 'Primary,Thumb,Backdrop', ImageTypeLimit: 1 })).then(raw => {
      if (api.getCurrentUserId() !== user || stamp !== generation) return;
      const response = itemsSchema.parse(raw); for (const id of missing) images.set(id, response.Items.find(item => item.Id === id) ?? null);
      for (const card of cards) applyArt(card, images.get(card.dataset.id ?? ''), api);
    }).catch(() => { if (stamp === generation) for (const id of missing) images.set(id, null); }).finally(() => { imageWork = false; kick(); });
  }
  function clearDetail(page: HTMLElement): void {
    page.classList.remove('utv-detail-ready'); delete page.dataset.utvDetailId;
    page.querySelectorAll(':scope>.utv-detail-art,:scope>.utv-detail-genres,:scope>.utv-detail-personnel').forEach(node => { node.remove(); });
    const tools = page.querySelector<HTMLDetailsElement>('.utv-detail-tools'); if (!tools) return;
    const parent = tools.parentElement; if (parent) for (const button of Array.from(tools.querySelectorAll('button'))) parent.insertBefore(button, tools);
    toolCleanup.get(tools)?.(); tools.remove();
  }
  async function detail(): Promise<void> {
    const page = visiblePage('#itemDetailPage'), api = client(), id = route().params.get('id'), user = api?.getCurrentUserId(); if (!page || !api || !id || !user || detailWork) return;
    if (!page.querySelector('.detailPagePrimaryContainer')) return;
    if (page.dataset.utvDetailId === id || page.dataset.utvDetailExcluded === id) { adaptationReady = true; return; }
    detailWork = true; const stamp = generation;
    try {
      const item = itemSchema.parse(await bounded(api.getItem(user, id)));
      if (stamp !== generation || !visible(page) || route().params.get('id') !== id || api.getCurrentUserId() !== user) return;
      if (!['Movie', 'Series', 'Season', 'Episode'].includes(item.Type)) { clearDetail(page); page.dataset.utvDetailExcluded = id; adaptationReady = true; return; }
      clearDetail(page);
      const art = owned('div', 'utv-detail-art'); art.setAttribute('aria-hidden', 'true');
      const imageId = item.BackdropImageTags?.length ? id : item.ParentBackdropItemId, tag = item.BackdropImageTags?.[0] ?? item.ParentBackdropImageTags?.[0];
      if (imageId) { const url = api.getImageUrl(imageId, { type: 'Backdrop', index: 0, maxWidth: 1920, quality: 90, ...(tag ? { tag } : {}) }); await decode(url); art.style.backgroundImage = 'url(' + JSON.stringify(url) + ')'; }
      if (stamp !== generation || !visible(page) || route().params.get('id') !== id) return;
      const genres = owned('div', 'utv-detail-genres'), brand = element('img'); brand.src = ASSETS + 'logo.png'; brand.alt = ''; genres.append(brand, element('span', '', [item.Type === 'Movie' ? 'Movie' : item.Type, ...(item.Genres ?? []).slice(0, 2)].join(' · ')));
      const personnel = owned('div', 'utv-detail-personnel');
      for (const [label, type, limit] of [['Starring', 'Actor', 3], ['Director', 'Director', 1]] as const) { const people = (item.People ?? []).filter(person => person.Type === type).slice(0, limit); if (!people.length) continue; const line = element('div'); line.append(element('span', '', label)); people.forEach((person, index) => { if (index) line.append(document.createTextNode(', ')); line.append(link(person.Name, itemHref({ ...item, Id: person.Id }, api))); }); personnel.append(line); }
      const buttons = page.querySelector<HTMLElement>('.mainDetailButtons');
      if (buttons && !buttons.querySelector('.utv-detail-tools')) {
        const tools = owned('details', 'utv-detail-tools'), trigger = element('summary'), menu = element('div'); trigger.setAttribute('aria-label', 'More actions'); trigger.title = 'More actions'; trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
        for (const button of Array.from(buttons.children)) if (button instanceof HTMLButtonElement && !button.matches('.btnPlay,.btnUserRating')) menu.append(button);
        tools.append(trigger, menu); tools.addEventListener('keydown', event => { if (event.key === 'Escape') { tools.open = false; trigger.focus(); } }); menu.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('button')) tools.open = false; });
        const outside = (event: PointerEvent): void => { if (tools.open && event.target instanceof Node && !tools.contains(event.target)) tools.open = false; }; document.addEventListener('pointerdown', outside); toolCleanup.set(tools, () => { document.removeEventListener('pointerdown', outside); }); buttons.append(tools);
      }
      page.prepend(art, genres, personnel); page.dataset.utvDetailId = id; page.classList.add('utv-detail-ready'); adaptationReady = true;
    } catch { fail(stamp); }
    finally { detailWork = false; kick(); }
  }
  function nativeLinks(): void {
    const server = client()?.serverId(); if (!server || server === 'undefined') return;
    for (const card of Array.from(document.querySelectorAll<HTMLElement>('.card'))) {
      const id = card.dataset.serverid && card.dataset.serverid !== 'undefined' ? card.dataset.serverid : server;
      for (const node of Array.from(card.querySelectorAll<HTMLAnchorElement>('a[href*="serverId=undefined"]'))) { const href = node.getAttribute('href'); if (href) node.setAttribute('href', href.replace('serverId=undefined', 'serverId=' + encodeURIComponent(id))); }
    }
  }
  function reconcile(): void {
    if (isPlayback()) {
      stop();
      gate.ready();
      return;
    }
    if (!settling) return; observe();
    const current = route(), loginPage = visiblePage('#loginPage'), homePage = visiblePage('#homeTab');
    document.body.classList.toggle('utv-login-active', !!loginPage); document.body.classList.toggle('utv-home-active', !!homePage && current.params.get('tab') !== '1');
    nativeLinks();
    if (loginPage) adaptationReady = login();
    else {
      void loadRoutes(); const headerReady = navigation();
      if (homePage && current.params.get('tab') !== '1') { shelves(); shortcuts(); void home(); }
      else if (current.path === '/details') void detail();
      else adaptationReady = !!activePage() && headerReady;
    }
    complete(generation);
    if (!adaptationReady && !homeWork && !detailWork) refreshTimer = setTimeout(reconcile, 120);
  }
  window.addEventListener('hashchange', begin);
  document.addEventListener('viewshow', begin);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) begin(); });
  document.addEventListener('play', () => { stop(); gate.ready(); }, true);
  document.addEventListener('keydown', event => { if (event.key !== 'Escape' || !document.body.classList.contains('utv-mobile-menu-open')) return; document.body.classList.remove('utv-mobile-menu-open'); const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Open Menu"]'); trigger?.setAttribute('aria-expanded', 'false'); trigger?.focus(); });
  begin();
}
