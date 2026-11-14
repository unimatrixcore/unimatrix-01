// The main scroll container belongs to the current page, not to its render cycle.
(() => {
  const key = 'collector:current-page-scroll:v1';
  let region, page, top = 0, left = 0, applying = false, observer, details = {};
  let reloading = null, settling = false, suspended = false, resuming = false, geometryObserver, observedGrid;
  const read = () => {
    let raw;
    try { raw = sessionStorage.getItem(key); } catch {}
    if (!raw) { try { raw = localStorage.getItem(key); } catch {} }
    try { return JSON.parse(raw); } catch { return null; }
  };
  function save() {
    if (!page) return;
    const saved = JSON.stringify({...page, top, left, details});
    try { sessionStorage.setItem(key, saved); } catch {}
    try { localStorage.setItem(key, saved); } catch {}
  }
  function restore() {
    if (!region || !page || applying || suspended) return;
    const view = document.getElementById('view-' + page.view);
    const virtual = view?.querySelector('.instant-list-host [data-list-complete]');
    // Reserve only the restored viewport; background paging may pause indefinitely.
    if (virtual) {
      const list = virtual.querySelector('[role="list"]');
      const grid = list?.querySelector('[role="presentation"]');
      if (geometryObserver && grid && observedGrid !== grid) {
        if (observedGrid) geometryObserver.unobserve(observedGrid);
        observedGrid = grid;geometryObserver.observe(grid);
      }
      if (reloading) {
        const bounds = region.getBoundingClientRect();
        const stopped = virtual.dataset.listComplete === 'true' || virtual.dataset.listState === 'error' || !!virtual.dataset.listPaused;
        if (stopped && virtual.dataset.listState !== 'pending' && list) {
          const available = Math.max(0,region.scrollTop + list.getBoundingClientRect().bottom - bounds.bottom);
          reloading.top = Math.min(reloading.top,available);
        }
        view.style.minHeight = `${reloading.top + region.clientHeight}px`;
        region.scrollTop = reloading.top;
        region.scrollLeft = reloading.left;
        const rendered = () => {
          if (!view.getClientRects().length || virtual.dataset.listState === 'pending') return false;
          if (virtual.dataset.listCount === '0') return stopped;
          if (!grid) return false;
          const clip = region.getBoundingClientRect(), content = grid.getBoundingClientRect();
          const start = Math.max(clip.top,content.top),end = Math.min(clip.bottom,content.bottom);
          const rows = [...grid.querySelectorAll('[data-index]')];
          if (!rows.length || start >= end) return false;
          const boxes = rows.map(node=>node.getBoundingClientRect());
          return Math.min(...boxes.map(rect=>rect.top)) <= start + 1 &&
            Math.max(...boxes.map(rect=>rect.bottom)) >= end - 1 &&
            rows.filter((_,index)=>boxes[index].bottom>start && boxes[index].top<end)
              .every(row=>[...row.querySelectorAll('[data-native-card]')].every(node=>node.firstElementChild));
        };
        if (!settling && rendered()) {
          settling = true;
          const checkpoint = reloading;
          const frame = window.requestAnimationFrame || (callback => setTimeout(callback, 0));
          let previous = '',stable = 0;
          const settle = () => {
            if (reloading !== checkpoint || suspended || !rendered()) {settling=false;return;}
            const clip = region.getBoundingClientRect();
            const signature = JSON.stringify([...grid.querySelectorAll('[data-index]')].flatMap(row=>{
              const box=row.getBoundingClientRect();
              return box.bottom>clip.top && box.top<clip.bottom ? [box.top,box.height,...[...row.querySelectorAll('[data-native-card]')].map(node=>node.getBoundingClientRect().height)] : [];
            }));
            stable = signature === previous ? stable + 1 : 0;previous=signature;
            if(stable<3) {frame(settle);return;}
            settling = false;
            reloading = null;
            view.style.minHeight = '';
            region.scrollTop = checkpoint.top;region.scrollLeft = checkpoint.left;
            top = region.scrollTop;left = region.scrollLeft;
            save();
          };
          frame(settle);
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
    const userScroll = event => {
      if (!reloading || suspended || event.type === 'keydown' && !['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) return;
      reloading = null;
      const view = document.getElementById('view-' + page.view);if(view) view.style.minHeight = '';
      top = region.scrollTop;left = region.scrollLeft;save();
    };
    region.addEventListener('wheel',userScroll,{passive:true});
    region.addEventListener('touchstart',userScroll,{passive:true});
    region.addEventListener('keydown',userScroll);
    observer = new MutationObserver(restore);
    // Observe content, not our own style writes on the views.
    observer.observe(region, {childList:true, subtree:true, characterData:true,attributes:true,attributeFilter:['data-list-complete','data-list-paused','data-list-state','data-list-count']});
    region.addEventListener('load', restore, true);
    if (typeof ResizeObserver !== 'undefined') {geometryObserver = new ResizeObserver(restore);geometryObserver.observe(region);}
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
