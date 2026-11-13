// The main scroll container belongs to the current page, not to its render cycle.
(() => {
  const key = 'collector:current-page-scroll:v1';
  let region, page, top = 0, left = 0, applying = false, observer, details = {};
  let reloading = null, settling = false, suspended = false, resuming = false;
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
  function save() {
    if (!page) return;
    try { sessionStorage.setItem(key, JSON.stringify({...page, top, left, details})); } catch {}
  }
  function restore() {
    if (!region || !page || applying || suspended) return;
    const view = document.getElementById('view-' + page.view);
    const virtual = view?.querySelector('.instant-list-host [data-list-complete]');
    // Virtual rows adjust the shared scroll offset as their measured heights arrive.
    // Keep a reload's reservation until paging completes, without undoing those adjustments.
    if (virtual) {
      if (reloading) {
        view.style.minHeight = `${reloading.top + region.clientHeight}px`;
        region.scrollTop = reloading.top;
        region.scrollLeft = reloading.left;
        if (!settling && virtual.dataset.listComplete === 'true' && view.getClientRects().length && [...virtual.querySelectorAll('[data-native-card]')].every(node => node.firstElementChild)) {
          settling = true;
          const checkpoint = reloading;
          const frame = window.requestAnimationFrame || (callback => setTimeout(callback, 0));
          frame(() => frame(() => {
            settling = false;
            if (reloading !== checkpoint || suspended) return;
            reloading = null;
            view.style.minHeight = '';
            region.scrollTop = top = checkpoint.top;
            region.scrollLeft = left = checkpoint.left;
            save();
          }));
        }
        return;
      }
      if (virtual.dataset.listComplete === 'true') view.style.minHeight = '';
      return;
    }
    applying = true;
    // Keep enough space while cards are replaced or fetched. Otherwise browsers
    // clamp scrollTop before the replacement content has a chance to arrive.
    if (view) view.style.minHeight = top > 0 ? `${top + region.clientHeight}px` : '';
    region.scrollTop = top;
    region.scrollLeft = left;
    applying = false;
  }
  function navigate(view, dataset) {
    const next = {view, dataset};
    if (page && page.view === view && page.dataset === dataset) { restore(); return; }
    const saved = !page && read();
    document.querySelectorAll('[id^="view-"]').forEach(node => { node.style.minHeight = ''; });
    top = saved && saved.view === view && saved.dataset === dataset ? Math.max(0, Number(saved.top) || 0) : 0;
    left = saved && saved.view === view && saved.dataset === dataset ? Math.max(0, Number(saved.left) || 0) : 0;
    details = saved && saved.view === view && saved.dataset === dataset ? saved.details || {} : {};
    reloading = saved && top > 0 && window.CollectorBackgroundLists ? {top,left} : null;
    page = next; save();
    if (region && !suspended) { region.scrollTop = top; region.scrollLeft = left; }
    restore();
  }
  function adopt() {
    if (!region || !page || suspended) return;
    top = region.scrollTop; left = region.scrollLeft; save(); restore();
  }
  function start() {
    region = document.getElementById('main-content');
    if (!region || observer) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    region.style.overflowAnchor = 'none';
    region.addEventListener('scroll', () => {
      if (applying || !page || suspended || resuming) return;
      if (reloading) { restore(); return; }
      top = region.scrollTop; left = region.scrollLeft; save(); restore();
    }, {passive:true});
    observer = new MutationObserver(restore);
    // Observe content, not our own style writes on the views.
    observer.observe(region, {childList:true, subtree:true, characterData:true,attributes:true,attributeFilter:['data-list-complete']});
    region.addEventListener('load', restore, true);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(restore).observe(region);
    window.addEventListener('pagehide', adopt);
    window.addEventListener('beforeunload', adopt);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  }
  window.CollectorScroll = {start, navigate, restore, save, adopt,
    suspend() { adopt(); suspended = true; },
    resume() {
      suspended = false;
      resuming = true;
      if (region && page) {
        applying = true;
        region.scrollTop = top; region.scrollLeft = left;
        applying = false;
      }
      restore();
      const frame = window.requestAnimationFrame || (callback => setTimeout(callback, 0));
      frame(() => frame(() => {
        if (suspended) { resuming = false; return; }
        if (region && page) { region.scrollTop = top; region.scrollLeft = left; }
        resuming = false;
      }));
    },
    remember(view, dataset, value) {
      if (page?.view === view && page.dataset === dataset) { details = value; save(); }
    },
    recall(view, dataset) {
      const saved = page ? {...page, details} : read();
      return saved?.view === view && saved.dataset === dataset ? saved.details || {} : {};
    }
  };
})();
