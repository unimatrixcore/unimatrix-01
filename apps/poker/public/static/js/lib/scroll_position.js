// The main scroll container belongs to the current page, not to its render cycle.
(() => {
  const key = 'collector:current-page-scroll:v1';
  let region, page, top = 0, left = 0, applying = false, observer, details = {};
  const read = () => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
  function save() {
    if (!page) return;
    try { sessionStorage.setItem(key, JSON.stringify({...page, top, left, details})); } catch {}
  }
  function restore() {
    if (!region || !page || applying) return;
    applying = true;
    // Keep enough space while cards are replaced or fetched. Otherwise browsers
    // clamp scrollTop before the replacement content has a chance to arrive.
    const view = document.getElementById('view-' + page.view);
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
    page = next; save(); restore();
  }
  function adopt() {
    if (!region || !page) return;
    top = region.scrollTop; left = region.scrollLeft; save(); restore();
  }
  function start() {
    region = document.getElementById('main-content');
    if (!region || observer) return;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    region.style.overflowAnchor = 'none';
    region.addEventListener('scroll', () => {
      if (applying || !page) return;
      top = region.scrollTop; left = region.scrollLeft; save(); restore();
    }, {passive:true});
    observer = new MutationObserver(restore);
    // Observe content, not our own style writes on the views.
    observer.observe(region, {childList:true, subtree:true, characterData:true});
    region.addEventListener('load', restore, true);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(restore).observe(region);
    window.addEventListener('pagehide', adopt);
    window.addEventListener('beforeunload', adopt);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  }
  window.CollectorScroll = {start, navigate, restore, save, adopt,
    remember(view, dataset, value) {
      if (page?.view === view && page.dataset === dataset) { details = value; save(); }
    },
    recall(view, dataset) {
      const saved = page ? {...page, details} : read();
      return saved?.view === view && saved.dataset === dataset ? saved.details || {} : {};
    }
  };
})();
