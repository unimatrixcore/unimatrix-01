// Every asynchronous operation is bound to the dataset that started it.
let activeDatasetId = null, datasetEpoch = 0, datasetSwitching = false;
let datasets = [], modelPrediction = null, modelRequest = 0, reviewSaving = false;
const pendingDatasetRequests = new Set();
const nativeFetch = window.fetch.bind(window);
const datasetStorage = {
  getItem: key => localStorage.getItem(`ocr:${activeDatasetId}:${key}`),
  setItem: (key, value) => localStorage.setItem(`ocr:${activeDatasetId}:${key}`, value),
  removeItem: key => localStorage.removeItem(`ocr:${activeDatasetId}:${key}`)
};
function sampleKey(item) { return item.sample_key || item.filename || `${item.id}:${item.phash || ''}:${item.source || item.game_id || ''}`; }
function draftKey() { return `draft:${pool[currentReviewIdx] ? sampleKey(pool[currentReviewIdx]) : 'none'}`; }
function scopedImage(path) { return `${path}${path.includes('?') ? '&' : '?'}dataset_id=${encodeURIComponent(activeDatasetId)}`; }
function cropImage(item) { return streamImages.get(sampleKey(item))?.url || (item.image_url ? scopedImage(item.image_url) : `data:image/png;base64,${item.base64_image}`); }
function datasetTimeout(callback, delay) {
  const epoch = datasetEpoch;
  return window.setTimeout(() => { if (epoch === datasetEpoch && !datasetSwitching) callback(); }, delay);
}
async function datasetFetch(url, options = {}) {
  const datasetId = options.datasetId || activeDatasetId;
  const epoch = datasetEpoch;
  const headers = new Headers(options.headers || {});
  if (datasetId) headers.set('X-Dataset-ID', datasetId);
  const request = (async () => {
    const response = await nativeFetch(url, {...options, headers});
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (epoch !== datasetEpoch) throw new Error('Dataset changed; stale response ignored.');
      if (error.name === 'AbortError') throw error;
      throw new Error(`Unexpected collector response (HTTP ${response.status}). Refresh and try again.`);
    }
    if (epoch !== datasetEpoch) throw new Error('Dataset changed; stale response ignored.');
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return {ok: response.ok, status: response.status, json: async () => {
      if (epoch !== datasetEpoch) throw new Error('Dataset changed; stale response ignored.');
      return data;
    }};
  })();
  pendingDatasetRequests.add(request);
  try { return await request; } finally { pendingDatasetRequests.delete(request); }
}
async function refreshDatasets() {
  if(window.CollectorBackgroundLists) {
    await window.CollectorBackgroundLists.invalidate("/api/datasets","");
    const data=await window.CollectorBackgroundLists.resolveDataset(activeDatasetId || localStorage.getItem('ocr:active-dataset'));
    datasets=data.items;return data;
  }
  const response = await nativeFetch('/api/datasets?include_archived=true');
  if (!response.ok) throw new Error('Could not load datasets.');
  const data = await response.json();
  datasets = Array.isArray(data) ? data : data.datasets;
  return data;
}
function renderDatasetNavigator() {
  const select = document.getElementById('dataset-select');
  const archived = document.getElementById('dataset-archived');
  select.replaceChildren(); archived.replaceChildren();
  if(window.CollectorBackgroundLists) {
    for(const control of [select,archived]) (control.closest('[data-slot="native-select-wrapper"]') || control).classList.add("hidden");
    document.getElementById("dataset-restore").classList.add("hidden");
    window.CollectorSharedUi.renderDatasetPicker({
      activeId:activeDatasetId,
      activeName:datasets.find(item=>item.id===activeDatasetId)?.name || "Choose dataset",
      changed:items=>{const current=datasets.find(item=>item.id===activeDatasetId);datasets=[...items];if(current && !datasets.some(item=>item.id===current.id)) datasets.push(current);},
      select:async item=>{try {if(item.archived){await datasetFetch(`/api/datasets/${encodeURIComponent(item.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({archived:false})});await refreshDatasets();renderDatasetNavigator();showToast('Dataset restored.','success');}else await switchDataset(item.id);}catch(error){reportDatasetError(error);}}
    });
    document.getElementById('dataset-archive-empty')?.classList.add('hidden');return;
  }
  datasets.forEach(dataset => {
    const option = new Option(dataset.name, dataset.id);
    (dataset.archived ? archived : select).add(option);
  });
  select.value = activeDatasetId;
  if (!activeDatasetId) return;
  const hasArchived = archived.options.length > 0;
  archived.classList.toggle('hidden', !hasArchived);
  const restore = document.getElementById('dataset-restore');
  restore.disabled = !hasArchived;
  restore.classList.toggle('hidden', !hasArchived);
  document.getElementById('dataset-archive-empty')?.classList.toggle('hidden', hasArchived);
}
async function initDatasets() {
  const data = await refreshDatasets();
  const remembered = localStorage.getItem('ocr:active-dataset');
  activeDatasetId = datasets.some(d => d.id === remembered && !d.archived) ? remembered : (data.default_dataset_id || datasets.find(d => !d.archived)?.id);
  if (!activeDatasetId) throw new Error('No dataset is available.');
  localStorage.setItem('ocr:active-dataset',activeDatasetId);window.dispatchEvent?.(new Event('poker-dataset-change'));
  renderDatasetNavigator();
  const manager = document.getElementById('dataset-manager');
  const openDatasetManager = mode => {
    document.getElementById('dataset-action-title').textContent = mode === 'create' ? 'Create dataset' : mode === 'rename' ? 'Rename dataset' : 'Manage datasets';
    document.querySelectorAll('[data-dataset-name]').forEach(el => el.classList.toggle('hidden', mode === 'manage'));
    document.querySelectorAll('[data-dataset-management]').forEach(el => el.classList.toggle('hidden', mode !== 'manage'));
    document.getElementById('dataset-create').classList.toggle('hidden', mode !== 'create');
    document.getElementById('dataset-rename').classList.toggle('hidden', mode !== 'rename');
    document.getElementById('dataset-name-input').value = mode === 'rename' ? (datasets.find(d => d.id === activeDatasetId)?.name || '') : '';
    manager.open = true;
    if (mode !== 'manage') document.getElementById('dataset-name-input').focus({preventScroll:true});
  };
  document.getElementById('dataset-create-open').onclick = () => openDatasetManager('create');
  document.getElementById('dataset-rename-open').onclick = () => openDatasetManager('rename');
  manager.querySelector('summary').onclick = event => { event.preventDefault(); if (manager.open) manager.open = false; else openDatasetManager('manage'); };
  document.getElementById('dataset-name-input').onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.repeat) return;
    const create = document.getElementById('dataset-create');
    (create.classList.contains('hidden') ? document.getElementById('dataset-rename') : create).click();
  };
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#dataset-tools')) manager.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && manager.open) { event.stopPropagation(); manager.open = false; (document.getElementById('dataset-catalog-label') || document.getElementById('dataset-select')).focus({preventScroll:true}); } });
  document.getElementById('dataset-select').onchange = e => switchDataset(e.target.value).catch(reportDatasetError);
  document.getElementById('dataset-create').onclick = async () => {
    const name = document.getElementById('dataset-name-input').value.trim();
    if (!name) { showToast('Enter a dataset name.', 'error'); return; }
    try {
      const data = await (await datasetFetch('/api/datasets', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})})).json();
      await refreshDatasets(); await switchDataset(data.dataset.id);
      document.getElementById('dataset-name-input').value = ''; manager.open = false;
    } catch (error) { reportDatasetError(error); }
  };
  document.getElementById('dataset-rename').onclick = async () => {
    const name = document.getElementById('dataset-name-input').value.trim();
    if (!name) { showToast('Enter the new dataset name.', 'error'); return; }
    try { await datasetFetch(`/api/datasets/${encodeURIComponent(activeDatasetId)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})}); await refreshDatasets(); renderDatasetNavigator(); manager.open = false; } catch (error) { reportDatasetError(error); }
  };
  document.getElementById('dataset-remove').onclick = async () => {
    const name = datasets.find(d => d.id === activeDatasetId)?.name;
    if (!await showConfirmModal('Archive dataset', `Archive “${name}”? All captures, labels and review history will be preserved. You can restore this dataset from Manage datasets.`)) return;
    try {
      let next = datasets.find(d => !d.archived && d.id !== activeDatasetId);
      if(!next && window.CollectorBackgroundLists) {const catalog=await window.CollectorBackgroundLists.readPages("/api/datasets",null,{include_archived:"1"},"datasets",true);next=catalog.items.find(d=>!d.archived && d.id!==activeDatasetId);}
      if (!next) { showToast('Create another dataset before archiving this one.', 'error'); return; }
      const previous = activeDatasetId;
      await switchDataset(next.id);
      await datasetFetch(`/api/datasets/${encodeURIComponent(previous)}`, {method:'DELETE'});
      await refreshDatasets(); renderDatasetNavigator();
    } catch (error) { reportDatasetError(error); }
  };
  document.getElementById('dataset-restore').onclick = async () => {
    const id = document.getElementById('dataset-archived').value;
    if (!id) return;
    try { await datasetFetch(`/api/datasets/${encodeURIComponent(id)}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({archived:false})}); await refreshDatasets(); renderDatasetNavigator(); showToast('Dataset restored.', 'success'); } catch (error) { reportDatasetError(error); }
  };
  document.getElementById('dataset-sync').onclick = async () => {
    if (!await showConfirmModal('Refresh dataset crops', 'Recrop saved captures in this dataset using the current region layout? Predictions remain in history and fresh suggestions will use the updated pixels.')) return;
    showLoading(true, 'Refreshing dataset crops…');
    try {
      await datasetFetch('/api/sync', {method:'POST'});
      let status = await (await datasetFetch('/api/sync_status')).json();
      while (status.is_syncing) {
        updateLoadingProgress(status.current_action || 'Refreshing crops…', status.total ? status.progress / status.total * 100 : 0);
        await new Promise(resolve => window.setTimeout(resolve, 500));
        status = await (await datasetFetch('/api/sync_status')).json();
      }
      const data = await (await datasetFetch(`/api/initial_data?queue_mode=paged${window.CollectorBackgroundLists?'&background_lists=1':''}`)).json();
      frames = []; pool = []; usernamePool.counts.clear(); modelRequest++;
      loadDatabase(data.db || []); void refreshNames(""); await recoverSession(data.session);if(queueMode) applyCollectionPage(data.collection_page);renderFrames();
      setView('collection'); renderDatasetNavigator(); await waitForCurrentViewport();
    } catch (error) { reportDatasetError(error); } finally { showLoading(false); }
  };
  document.getElementById('model-use').onclick = useModelSuggestion;
  document.getElementById('model-accept').onclick = acceptModelSuggestion;
  document.getElementById('model-retry').onclick = () => requestModelSuggestion(pool[currentReviewIdx], true);
  document.getElementById('label-save').onclick = saveCurrentAndNext;
}
let captureWatch = null, manualCaptureBusy = false, watchNeedsRecovery = false, capturePresentationGeneration = 0;
function captureContext() { return {datasetId:activeDatasetId,epoch:datasetEpoch,monitor:monitorSelect?.value}; }
function captureContextMatches(value) { return value.datasetId === activeDatasetId && value.epoch === datasetEpoch && value.monitor === monitorSelect?.value && !datasetSwitching; }
function canWatchCapture(value) { return captureContextMatches(value) && currentView === 'collection' && !manualCaptureBusy && !isRecovering && !labelingUnlocked && !reviewUnlocked && !!value.monitor; }
function queuedCropCount() {
  if(queueMode) return queueSummary?.total || 0;
  const keys = new Set(pool.map(item => `${item.id}:${item.phash || sampleKey(item)}`));
  for (const frame of frames) for (const item of frame.regions || []) keys.add(`${item.id}:${item.phash || sampleKey(item)}`);
  return keys.size;
}
function mergeWatchFrames(incoming, render = true) {
  if (!Array.isArray(incoming)) throw new Error('Watch recovery did not return a crop queue');
  for (const frame of incoming) {
    if (!frame.regions?.length || frames.some(existing => String(existing.id) === String(frame.id) || (frame.source && existing.source === frame.source))) continue;
    frames.push({...frame,watch:true,loading:false,regions:frame.regions.map(item => ({...item,label:'',reviewed:false,discarded:false}))});
  }
  if (render) renderFrames();
}
async function stopCaptureWatch(reason = 'Stopped') {
  capturePresentationGeneration++;
  window.CollectorCaptureAnimation?.cancel();
  if (!captureWatch) return;
  await captureWatch.stop(reason);
  await captureWatch.whenIdle();
}
async function stopAndRecoverWatch(reason = 'Stopped') {
  const captured = captureContext(), recover = watchNeedsRecovery || captureWatch?.isActive() || captureWatch?.isBusy();
  await stopCaptureWatch(reason);
  if (!recover || !captureContextMatches(captured)) return;
  if(queueMode) {
    await loadCollectionPage();watchNeedsRecovery=false;
    captureWatch?.recordQueued(queueSummary?.total || 0);
    await saveSessionProgress(true);return;
  }
  const data = await (await datasetFetch('/api/watch/claim',{method:'POST',datasetId:captured.datasetId,headers:{'Content-Type':'application/json'},body:'{}'})).json();
  if (!captureContextMatches(captured)) return;
  mergeWatchFrames(data.frames);
  captureWatch?.recordQueued(data.queued_count);
  watchNeedsRecovery = false;
  await saveSessionProgress(true);
}
let lastWatchPresentation = {active:false,busy:false,status:'off'};
function renderCapturePresentation(state = lastWatchPresentation) {
  const start = document.getElementById('watch-start'), stop = document.getElementById('watch-stop'), status = document.getElementById('watch-status');
  if (!start || !stop || !status) return;
  start.classList.toggle('hidden',state.active);
  if (!manualCaptureBusy) { stop.classList.toggle('hidden',!state.active && !state.busy); stop.disabled = !state.active; }
  const queueFull = queueMode && queueSummary?.total >= 5000;
  const unavailable = manualCaptureBusy || datasetSwitching || isRecovering || labelingUnlocked || reviewUnlocked || queueFull;
  start.disabled = !!(state.busy || unavailable);
  const capture = document.getElementById('capture-once');
  if (capture) capture.disabled = !!(state.active || state.busy || unavailable);
  for (const id of ['watch-interval']) document.getElementById(id).disabled = !!(state.active || state.busy || manualCaptureBusy);
  const interval=document.getElementById('watch-interval').value || '2';
  const clear=document.getElementById('btn-clear-frames');
  if (clear) clear.disabled=(queueMode ? !queueSummary?.total : !frames.length && !pool.length) && !watchNeedsRecovery && !state.active && !state.busy && !manualCaptureBusy;
  let label = 'Ready', detail = `Every ${interval}s · New unique crops`, tone = 'ready';
  if (manualCaptureBusy) { label='Capturing';detail='Esc cancels the preview. Admitted crops stay queued.';tone='busy'; }
  else if (state.status === 'error') { label='Error';detail=state.message || 'Capture stopped. Press Record to try again.';tone='error'; }
  else if (queueFull || /queue full/i.test(state.message || '')) { label='Queue full';detail='5,000-crop limit · Save or remove crops to resume.';tone='paused'; }
  else if (state.active) { label=state.status === 'starting' ? 'Starting' : 'Recording';detail=`${state.added || 0} new ${(state.added || 0) === 1 ? 'crop' : 'crops'} this run`;tone=state.status === 'starting' ? 'busy' : 'watching'; }
  else if (state.busy) { label='Stopping';detail='Finishing the current capture.';tone='busy'; }
  else if (labelingUnlocked || reviewUnlocked) detail='Review the current crops before collecting more.';
  else if (state.status === 'stopped') detail='Recording paused. Press W to resume.';
  status.dataset.active=String(state.active);status.dataset.state=tone;
  if (status.textContent !== label) status.textContent=label;
  const description=document.getElementById('watch-status-detail');
  if (description && description.textContent !== detail) description.textContent=detail;
}
function renderWatchStatus(state) { lastWatchPresentation=state;renderCapturePresentation(state);updateStepperButtons(); }
function setRecordingSettingsOpen(open) {
  if (window.CollectorSharedUi?.setRecordingSourceOpen?.('watch-settings', open)) return;
  const settings=document.getElementById('watch-settings');
  if (settings) settings.open=open;
}
function initCaptureToolbar() {
  const settings=document.getElementById('watch-settings'),toggle=settings?.querySelector?.('[data-recording-source-trigger], summary');
  document.getElementById('capture-once').onclick=captureFrame;
  const refresh=document.getElementById('capture-sources-refresh');
  if (refresh) refresh.onclick=() => refreshCaptureSources().catch(error => showToast(error.message,'error'));
  const summary=() => {
    const text=document.getElementById('watch-settings-summary');
    if (text) text.textContent=`Every ${document.getElementById('watch-interval').value}s · Saved as you capture`;
    renderCapturePresentation();
  };
  for (const id of ['watch-interval']) document.getElementById(id).onchange=summary;
  document.getElementById('collection-previous').onclick=()=>loadCollectionPage(collectionPrevious.at(-1),'previous').catch(error=>showToast(error.message,'error'));
  document.getElementById('collection-next').onclick=()=>loadCollectionPage(collectionNextCursor,'next').catch(error=>showToast(error.message,'error'));
  document.getElementById('btn-next-batch').onclick=()=>commitQueueBatch(true);
  // Shared Popover owns outside-click, Escape, and focus restoration. The
  // standalone template retains native details behavior for development/tests.
  if (settings?.tagName === 'DETAILS') {
    document.addEventListener('pointerdown',event => { if (!settings.contains?.(event.target)) setRecordingSettingsOpen(false); });
    document.addEventListener('keydown',event => { if (event.key === 'Escape' && settings.open) { setRecordingSettingsOpen(false);event.stopPropagation();toggle?.focus({preventScroll:true}); } });
  }
  const dock=document.getElementById('record-dock');
  const reserve=() => {
    const height=dock?.getBoundingClientRect?.().height;
    if (height) document.getElementById('view-collection').style.setProperty('--record-dock-space',`${Math.ceil(height)+48}px`);
  };
  if (dock && window.ResizeObserver) { const observer=new window.ResizeObserver(reserve);observer.observe(dock); }
  window.addEventListener('resize',reserve);
  reserve();summary();
}
function initCaptureWatch() {
  initCaptureToolbar();
  captureWatch = window.CollectorWatchCapture.create({
    getContext:captureContext,canRun:canWatchCapture,queuedCount:queuedCropCount,onStatus:renderWatchStatus,
    open:async (settings,captured) => {
      watchNeedsRecovery = true;
      await saveSessionProgress(true);
      if (!canWatchCapture(captured)) throw new Error('Collection changed before watch started');
      return (await datasetFetch('/api/watch/start',{method:'POST',datasetId:captured.datasetId,headers:{'Content-Type':'application/json'},body:JSON.stringify({monitor:captured.monitor,interval_seconds:settings.intervalSeconds,queue_mode:'paged'})})).json();
    },
    scan:async (lease,captured) => (await datasetFetch('/api/watch/tick',{method:'POST',datasetId:captured.datasetId,headers:{'Content-Type':'application/json'},body:JSON.stringify({lease_id:lease})})).json(),
    close:async (lease,captured) => datasetFetch('/api/watch/stop',{method:'POST',datasetId:captured.datasetId,keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({lease_id:lease})}),
    onBatch:async (result,captured,isCurrent) => {
      if (!isCurrent()) return;
      if(queueMode) {
        applyQueueSummary(result.summary);
        const incoming=(result.frames || []).flatMap(frame=>(frame.regions || []).map(item=>({...item,source:item.source || frame.source,game_id:item.game_id || frame.game_id,frame_id:item.frame_id || frame.id}))).sort((a,b)=>b.queue_id-a.queue_id);
        collectionCursor=null;collectionPrevious=[];
        collectionItems=[...incoming,...collectionItems.filter(item=>!incoming.some(added=>sampleKey(added)===sampleKey(item)))].slice(0,COLLECTION_PAGE_SIZE);
        for(const frame of result.frames || []) await showCaptureAdmission(frame,frame.regions || [],()=>isCurrent() && captureContextMatches(captured));
        if(!isCurrent() || !captureContextMatches(captured)) return;
        await loadCollectionPage();
        return;
      }
      const data = await (await datasetFetch('/api/watch/claim',{method:'POST',datasetId:captured.datasetId,headers:{'Content-Type':'application/json'},body:'{}'})).json();
      if (!isCurrent() || !captureContextMatches(captured)) return;
      const prior = new Set(collectionCrops().map(collectionCropKey));
      mergeWatchFrames(data.frames,false);
      let animated = false;
      for (const frame of result.frames || []) {
        const admitted = (frame.regions || []).filter(item => !prior.has(collectionCropKey(item)));
        if (admitted.length) animated = true;
        await showCaptureAdmission(frame,admitted,() => isCurrent() && captureContextMatches(captured));
        if (!isCurrent()) return;
      }
      if (!animated && isCurrent()) renderFrames();
      await saveSessionProgress(true);
    }
  });
  document.getElementById('watch-start').onclick = () => {
    setRecordingSettingsOpen(false);
    watchNeedsRecovery = true;
    captureWatch.start({intervalSeconds:Number(document.getElementById('watch-interval').value),queueMode:'paged'}).catch(error => renderWatchStatus({active:false,busy:false,status:'error',message:error.message}));
  };
  document.getElementById('watch-stop').onclick = () => stopAndRecoverWatch('Stopped').catch(error => showToast(error.message,'error'));
  document.addEventListener('visibilitychange',() => {
    if (document.hidden) {
      window.CollectorSharedUi?.closeMenus?.();
      capturePresentationGeneration++;
      window.CollectorCaptureAnimation?.cancel();
    } else if (watchNeedsRecovery && !captureWatch?.isActive() && !captureWatch?.isBusy()) {
      void stopAndRecoverWatch('Capture paused').catch(error => showToast(error.message,'error'));
    }
  });
  window.leavePokerOcr = () => stopAndRecoverWatch('Collection paused');
  window.addEventListener('pagehide',() => { void stopCaptureWatch('Page closed'); });
  window.addEventListener('beforeunload',() => { void stopCaptureWatch('Page closed'); });
  renderWatchStatus({active:false,busy:false,status:'off'});
}

function reportDatasetError(error) { showLoading(false); renderDatasetNavigator(); showToast(error.message, 'error'); }
let modelTextTransition = null, modelTextElement = null;
let reviewVisual = null;
// Crop pixels and prediction share one clock, including when inference arrives late.
function beginReviewVisual(item) {
  const key = sampleKey(item);
  if (reviewVisual?.key === key) return;
  const image = document.getElementById('focus-img');
  const panel = document.getElementById('model-review');
  if (!image || !panel) return;
  const previous = reviewVisual;
  const poses = [image, panel].map(target => {
    const style = window.getComputedStyle(target);
    return {opacity:style.opacity, transform:style.transform};
  });
  previous?.animations.forEach(animation => animation.cancel());
  modelTextTransition?.dispose(); modelTextTransition = null; modelTextElement = null;
  const state = reviewVisual = {key, image, panel, animations:[], ready:false, text:'', entering:false};
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animatePair = (entering) => {
    const start = document.timeline?.currentTime;
    const promises = [];
    [image, panel].forEach((target, index) => {
      if (target === panel && (entering ? !state.text : !document.getElementById('model-text').textContent)) return;
      if (reduced || typeof target.animate !== 'function') return;
      const hidden = {opacity:0, transform:'scale(.9) translateY(10px)'};
      const shown = {opacity:1, transform:'scale(1) translateY(0)'};
      const animation = target.animate(entering ? [hidden, shown] : [poses[index], hidden],
        {duration:entering ? 300 : 150, easing:'cubic-bezier(.4,0,.2,1)', fill:'both'});
      // Both animations use the same document timeline origin, not successive timers.
      if (start != null) animation.startTime = start;
      state.animations.push(animation);
      promises.push(animation.finished.catch(() => {}));
    });
    return Promise.all(promises);
  };
  state.animatePair = animatePair;
  state.exited = animatePair(false).then(() => {
    if (reviewVisual !== state) return;
    image.style.visibility = panel.style.visibility = 'hidden';
    state.animations.forEach(animation => animation.cancel()); state.animations = [];
  });
  const source = cropImage(item);
  const preload = new Image(); preload.src = source;
  state.decoded = typeof preload.decode === 'function' ? preload.decode().catch(() => {}) : Promise.resolve();
  state.source = source;
}
async function revealReviewVisual(state) {
  if (!state.ready || state.entering) return;
  state.entering = true;
  await Promise.all([state.exited, state.decoded]);
  if (reviewVisual !== state) return;
  state.image.src = state.source;
  state.image.style.visibility = 'visible';
  const text = document.getElementById('model-text');
  text.textContent = state.text;
  state.panel.style.visibility = state.text ? 'visible' : 'hidden';
  state.panel.style.opacity = state.text ? '1' : '0';
  state.panel.setAttribute('aria-hidden', String(!state.text));
  await state.animatePair(true);
  if (reviewVisual !== state) return;
  state.animations.forEach(animation => animation.cancel()); state.animations = [];
  state.settled = true;
  if (reviewClock.key === state.key) resumeReviewClock('loading');
  document.getElementById('model-use').disabled = typeof modelPrediction?.text !== 'string' || reviewSaving;
  document.getElementById('model-accept').disabled = !canAcceptPrediction(modelPrediction) || reviewSaving;
}
function resumeModelClock() {
  if (!reviewVisual || reviewVisual.settled) resumeReviewClock('loading');
}
let lastModelError = null;
function readablePrediction(text) {
  return typeof text === 'string' && text.replace(/[\s\p{Cc}\p{Cf}]/gu, '').length > 0;
}
function canAcceptPrediction(prediction) {
  return !!prediction?.schema_valid && (readablePrediction(prediction.text) ||
    (prediction.text === '' && prediction.raw_text === ''));
}
function clearModelTextTransition() {
  if (reviewVisual) {
    reviewVisual.animations.forEach(animation => animation.cancel());
    reviewVisual.image.style.visibility = '';
    reviewVisual = null;
  }
  modelTextTransition?.dispose();
  modelTextTransition = null; modelTextElement = null;
}
function presentModelText(text, pending = false, immediate = false) {
  if (reviewVisual) {
    if (pending) return;
    reviewVisual.text = text; reviewVisual.ready = true;
    if (reviewVisual.settled) {
      document.getElementById('model-text').textContent = text;
      reviewVisual.panel.style.visibility = text ? 'visible' : 'hidden';
      reviewVisual.panel.style.opacity = text ? '1' : '0';
      reviewVisual.panel.setAttribute('aria-hidden', String(!text));
    } else void revealReviewVisual(reviewVisual);
    return;
  }
  const element = document.getElementById('model-text');
  if (!element) return;
  if (element !== modelTextElement) clearModelTextTransition();
  const create = window.CollectorSharedUi?.createTextTransition;
  if (!modelTextTransition && create) {
    modelTextElement = element;
    modelTextTransition = create(element, {container:document.getElementById('model-review'), durationMs:300, mode:'container'});
  }
  if (modelTextTransition) {
    if (pending) modelTextTransition.pending();
    else modelTextTransition.update(text, {immediate});
  } else {
    element.textContent = pending ? '' : text;
    const panel = document.getElementById('model-review');
    if (panel) {
      panel.style.visibility = !pending && text ? 'visible' : 'hidden';
      panel.style.opacity = !pending && text ? '1' : '0';
    }
  }
}
async function switchDataset(id) {
  if (datasetSwitching || id === activeDatasetId) return;
  const destination = currentView === 'database' ? 'database' : 'collection';
  if(typeof resetAiReview==='function') resetAiReview();
  datasetSwitching = true;
  clearModelTextTransition();
  if (typeof clearGamificationEffects === 'function') clearGamificationEffects();
  await stopCaptureWatch('Dataset changed');
  showLoading(true, 'Saving progress and opening dataset…');
  try {
    await saveSessionProgress(true);
    // A completed capture/commit can start another request; drain the whole chain.
    do {
      await Promise.allSettled([...pendingDatasetRequests]);
      await new Promise(resolve => window.setTimeout(resolve, 0));
    } while (pendingDatasetRequests.size);
    await saveSessionProgress(true);
    datasetEpoch++; modelRequest++; dbSuggestionRequest++; dbReviewSaving = false; reviewSaving = false;
    if (saveTimeout) clearTimeout(saveTimeout);
    activeDatasetId = id; watchNeedsRecovery = false;resetQueueState();
    localStorage.setItem('ocr:active-dataset', id);window.dispatchEvent?.(new Event('poker-dataset-change'));
    frames = []; pool = []; dbEntries = []; gameCurrencyMap = {}; globalHistory = [];
    usernamePool.counts.clear(); nativeNameSuggestions=[];lastNamesQuery=""; namesRequest++; dbTotal=0;dbSelectedMetadata.clear();dbDrafts.clear(); selectedFiles.clear(); selectedPoolIndices.clear();
    currentReviewIdx = 0; maxReachedIdx = 0; dbPage = 1; editingPoolIdx = -1;
    currentSuggestion = ''; modelPrediction = null; lastValue = ''; actionHistory = [];
    sessionScore = 0; currentCombo = 0; maxCombo = 0; quickLabels = 0; autoCompletes = 0; reviewAwards = {}; resetReviewClock();
    highscoreAdded = false; usedAutoComplete = false; isTabbing = false;
    currentValidationError = null; isPaused = false; pauseStartTime = 0;
    labelingUnlocked = false; reviewUnlocked = false; isRecovering = true;
    labelInput.value = ''; labelInput.disabled = false; ghostText.textContent = '';
    document.getElementById('pause-overlay').classList.add('hidden');
    ['review-search','db-search','review-bulk-label-input','db-bulk-label-input'].forEach(key => document.getElementById(key).value = '');
    ['review-search-list','db-search-list','review-bulk-list','db-bulk-list','edit-datalist'].forEach(key => document.getElementById(key).replaceChildren());
    window.CollectorSharedUi?.disposeMenus?.(frameListEl);
    if(window.CollectorBackgroundLists) [frameListEl, sessionReviewListEl, dbListEl].forEach(host => window.CollectorBackgroundLists.clear(host));
    frameListEl.replaceChildren(); sessionReviewListEl.replaceChildren(); dbListEl.replaceChildren();
    document.getElementById('db-statistics-dashboard').classList.add('hidden');
    setModelState('Select a crop to begin');
    const data = await (await datasetFetch(`/api/initial_data?queue_mode=paged${window.CollectorBackgroundLists?'&background_lists=1':''}`)).json();
    globalHistory = data.history || [];
    if(window.CollectorBackgroundLists) void refreshCompletionHistory(data.session).catch(error=>console.warn("History unavailable",error));
    loadMonitors(data.sources || data.monitors, data.settings?.last_monitor); loadDatabase(data.db || []);void refreshNames("");
    await recoverSession(data.session);
    if(queueMode) applyCollectionPage(data.collection_page);
    if(destination === 'database') await probeDatabaseAvailability();
    renderFrames(); renderDatabase();
    setView(destination); renderDatasetNavigator(); await waitForCurrentViewport();
  } finally { datasetSwitching = false; isRecovering = false; updateStepperButtons(); showLoading(false); }
}
function setModelState(message, prediction = null) {
  modelPrediction = prediction;
  const panel = document.getElementById('model-review');
  const state = /saving/i.test(message) ? 'saving' : /loading/i.test(message) ? 'loading' : /failed|unavailable|error/i.test(message) ? 'error' : prediction ? prediction.schema_valid ? 'ready' : 'invalid' : 'idle';
  panel?.setAttribute?.('aria-busy', String(state === 'loading' || state === 'saving'));
  panel?.setAttribute?.('data-state', state);
  document.getElementById('model-state').textContent = message;
  document.getElementById('model-raw').textContent = prediction ? (prediction.raw_text === '' ? '(blank)' : prediction.raw_text ?? '—') : '—';
  const displayText = readablePrediction(prediction?.text) ? prediction.text : '';
  if (panel) panel.title = state === 'invalid' ? message : 'Model prediction';
  presentModelText(displayText, state === 'loading', state === 'error' || state === 'idle');
  const visualPending = reviewVisual && !reviewVisual.settled;
  document.getElementById('model-use').disabled = typeof prediction?.text !== 'string' || reviewSaving || visualPending;
  document.getElementById('model-accept').disabled = !canAcceptPrediction(prediction) || reviewSaving || visualPending;
  if (state === 'loading') lastModelError = null;
  if (state === 'error' && message !== lastModelError) {
    lastModelError = message;
    if (typeof showToast === 'function') showToast(message, 'error');
  }
}
async function requestModelSuggestion(item, force = false) {
  if (!item) return;
  const requestId = ++modelRequest, epoch = datasetEpoch, key = sampleKey(item);
  freezeReviewClock('loading');
  setModelState('Loading local model…');
  if(window.CollectorBackgroundLists) window.CollectorBackgroundLists.clear(document.getElementById('label-history'));
  document.getElementById('label-history').textContent = 'Loading history…';
  refreshLabelHistory(item, requestId);
  try {
    const data = await (await datasetFetch('/api/model_suggestion', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sample_key:key, queue_id:item.queue_id, id:item.id, base64_image:item.base64_image, filename:item.filename, source:item.source, force})})).json();
    if (requestId !== modelRequest || epoch !== datasetEpoch || sampleKey(pool[currentReviewIdx]) !== key) return;
    const prediction = data.prediction;
    if (!prediction) { resumeModelClock(); setModelState(data.error || 'No suggestion for this crop'); return; }
    resumeModelClock();
    item.prediction = prediction; item.prediction_id = prediction.id;
    setModelState(prediction.schema_valid ? (prediction.text === '' ? 'Blank prediction · explicit acceptance required' : 'Ready for your review') : prediction.category === 'status' ? 'Unlisted status · edit to confirm' : 'Invalid format · correction required', prediction);
    refreshLabelHistory(item, requestId);
  } catch (error) {
    if (requestId === modelRequest && epoch === datasetEpoch) { resumeModelClock(); setModelState(`Model unavailable: ${error.message}`); }
  }
}
function useModelSuggestion() {
  if (!modelPrediction || reviewSaving || datasetSwitching || isPaused || reviewVisual && !reviewVisual.settled) return;
  freezeReviewClock('editing');
  usedAutoComplete = true;
  labelInput.value = modelPrediction.text ?? '';
  labelInput.dispatchEvent(new Event('input', {bubbles:true}));
  labelInput.focus({preventScroll:true}); labelInput.select();
}
async function acceptModelSuggestion() {
  if (!canAcceptPrediction(modelPrediction) || reviewSaving || datasetSwitching || isPaused || reviewVisual && !reviewVisual.settled || !pool[currentReviewIdx]) return;
  await persistReview(pool[currentReviewIdx], modelPrediction.text ?? '', 'accept');
}
async function persistReview(item, label, action) {
  if (reviewSaving) return;
  reviewSaving = true;
  const epoch = datasetEpoch, prediction = modelPrediction, index = currentReviewIdx;
  const wasReviewed = !!item.reviewed;
  const previousState = {label:item.label, reviewed:wasReviewed, discarded:!!item.discarded};
  freezeReviewClock('idle');
  setModelState('Saving reviewed label…', prediction);
  document.getElementById('label-save').disabled = true;
  try {
    const allow_outside_contract = action !== 'accept' && !!SchemaRegistry.validateReviewed(item.id, label).outsideContract;
    const data = await (await datasetFetch('/api/review_label', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sample_key:sampleKey(item),queue_id:item.queue_id, id:item.id, base64_image:item.base64_image, filename:item.filename, source:item.source, prediction_id:prediction?.id || item.prediction_id || null, label, action, allow_outside_contract})})).json();
    if (epoch !== datasetEpoch) return;
    if (data.success === false || !data.event) throw new Error(data.error || 'Reviewed label was not saved');
    const oldLabel = item.label;
    awardReviewedSample(item, label, action, prediction, wasReviewed, previousState);
    item.label = label; item.discarded = false; item.reviewed = true;
    if(queueMode) applyQueueSummary(data.summary);
    item.sample_key = sampleKey(item); item.review_event = data.event; item.review_action = action;
    if (prediction) { item.prediction = prediction; item.prediction_id = prediction.id; }
    finishReviewClock(item);
    syncPoolsWithLabelChange(oldLabel, label, item.id.includes('name') ? 'name' : null);
    // Retain the award marker locally until the session snapshot is durable too.
    datasetStorage.setItem(`draft:${sampleKey(item)}`, JSON.stringify({sample_key:sampleKey(item),idx:index,value:label,reviewed:true,reviewed_label:label,reward:item.review_reward || null,clock:item.review_clock}));
    await saveSessionProgress(true);
    datasetStorage.removeItem(`draft:${sampleKey(item)}`);
    updateStepperButtons(); renderDatasetNavigator();
    if (currentReviewIdx === index && pool[index] === item) {
      if(isContinuousReview()) await advanceContinuousReview();
      else if (currentReviewIdx === pool.length - 1) showLabelingStats(); else next();
    }
  } catch (error) { if (epoch === datasetEpoch) { showToast(error.message, 'error'); if (pool[currentReviewIdx] === item) setModelState('Save failed · your draft is preserved', prediction); } }
  finally {
    if (epoch === datasetEpoch) {
      if (reviewClock.key === sampleKey(item)) resumeReviewClock('idle');
      reviewSaving = false; document.getElementById('label-save').disabled = false;
      if (modelPrediction) setModelState(document.getElementById('model-state').textContent, modelPrediction);
    }
  }
}
async function persistEditedItem(item, label, action = 'correct') {
  const allow_outside_contract = action !== 'accept' && !!SchemaRegistry.validateReviewed(item.id, label).outsideContract;
  const data = await (await datasetFetch('/api/review_label', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sample_key:sampleKey(item),queue_id:item.queue_id, id:item.id, base64_image:item.base64_image, filename:item.filename, source:item.source, prediction_id:item.prediction_id || null, label, action, allow_outside_contract})})).json();
  if(queueMode) applyQueueSummary(data.summary);
  if (data.success === false || !data.event) throw new Error(data.error || 'Reviewed label was not saved');
  // Editing labels in the session/database grid never awards a new quick-label
  // bonus. Mark pool edits reviewed so rebuilding the queue cannot mint one.
  if (pool.includes(item)) {
    const receipt = reviewAwards[sampleKey(item)] || item.review_reward || {points:0, action, label, previouslyReviewed:true};
    reviewAwards[sampleKey(item)] = {...receipt, label};
    item.review_reward = reviewAwards[sampleKey(item)];
  }
  item.reviewed = true; item.review_event = data.event; item.review_action = action; item.label = label;
}
function renderPagedHistory(target,item) {
  const datasetId=activeDatasetId,epoch=datasetEpoch;
  window.CollectorBackgroundLists.render(target,{path:"/api/label_history",datasetId,query:{...(sampleKey(item)?{sample_key:sampleKey(item)}:{}),...(item.filename?{filename:item.filename}:{})},key:row=>row.id,height:240,rowHeight:52,minColumnWidth:1000,emptyLabel:"No review history yet.",
    card:row=>{const p=document.createElement('p'),entry=row.payload;p.textContent=row.kind==='prediction' ? `Prediction ${reviewTimestamp(entry.created_at ?? entry.timestamp)} · ${entry.model_id || 'Local model'} · raw: ${JSON.stringify(entry.raw_text)} · suggested label: ${JSON.stringify(entry.text)}` : `${reviewTimestamp(entry.created_at ?? entry.timestamp)} · ${entry.action || 'Review'} · saved label: ${JSON.stringify(entry.label)} · prediction ${entry.prediction_id || 'none'}`;return p;},
    changed:()=>{if(epoch!==datasetEpoch || datasetId!==activeDatasetId) window.CollectorBackgroundLists.clear(target);}});
}
async function refreshLabelHistory(item, requestId) {
  if(window.CollectorBackgroundLists) {renderPagedHistory(document.getElementById("label-history"),item);return;}
  try {
    const query = new URLSearchParams({sample_key:sampleKey(item), filename:item.filename || ''});
    const data = await (await datasetFetch(`/api/label_history?${query}`)).json();
    if (requestId !== modelRequest) return;
    renderHistory(document.getElementById('label-history'), data);
  } catch (error) { if (requestId === modelRequest) document.getElementById('label-history').textContent = `History unavailable: ${error.message}`; }
}
function reviewTimestamp(value) {
  if (value === null || value === undefined || value === '') return 'Unknown time';
  const date = new Date(/^\d+$/.test(String(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString([], {dateStyle:'medium', timeStyle:'short'});
}

function renderHistory(target, data) {
  target.replaceChildren();
  const predictions = data.predictions || [], events = data.events || data.history || data.reviews || [];
  for (const prediction of predictions) {
    const row = document.createElement('p');
    row.textContent = `Prediction ${reviewTimestamp(prediction.created_at ?? prediction.timestamp)} · ${prediction.model_id || 'Local model'} · raw: ${JSON.stringify(prediction.raw_text)} · suggested label: ${JSON.stringify(prediction.text)}`;
    target.appendChild(row);
  }
  for (const event of events) {
    const row = document.createElement('p');
    row.textContent = `${reviewTimestamp(event.created_at ?? event.timestamp)} · ${event.action || 'Review'} · saved label: ${JSON.stringify(event.label)} · prediction ${event.prediction_id || 'none'}`;
    target.appendChild(row);
  }
  if (!target.children.length) target.textContent = 'No review history yet.';
}

let frames = [], pool = [], dbEntries = [], currentReviewIdx = 0;
const legacyReviewDrafts=new Map();
const COLLECTION_PAGE_SIZE = 60, REVIEW_BATCH_SIZE = 100, REVIEW_PREFETCH = 10, REVIEW_HISTORY = 50;
let queueMode = false, queueSummary = null, reviewBatch = null;
let queueCompletedStats = {items:0,time:0};
let queueLastCommitReceipt = null, queueCompletionRecorded = false, queueCompletedResult = null;
let streamFetch = null, streamEpoch = 0, streamAdvancing = false, streamStats = null, streamCheckpointSequence = 0;
const streamImages = new Map();
function releaseStreamImages(keep = new Set()) {
  for(const [key,entry] of streamImages) if(!keep.has(key)) {
    entry.controller?.abort();if(entry.url) URL.revokeObjectURL(entry.url);streamImages.delete(key);
  }
}
async function preloadReviewImage(item) {
  if(!item?.image_url || typeof URL.createObjectURL!=='function') return;
  const key=sampleKey(item),existing=streamImages.get(key);
  if(existing) return existing.promise;
  const epoch=streamEpoch,controller=new AbortController(),entry={controller,url:null,promise:null};
  streamImages.set(key,entry);
  entry.promise=(async()=>{
    try {
      const response=await nativeFetch(scopedImage(item.image_url),{signal:controller.signal});
      if(!response.ok || typeof response.blob!=='function') return;
      const blob=await response.blob();
      if(epoch!==streamEpoch || streamImages.get(key)!==entry || controller.signal.aborted) return;
      entry.url=URL.createObjectURL(blob);
      const image=new Image();image.src=entry.url;
      if(image.decode) await image.decode().catch(()=>{});
    } catch(error) {if(error.name!=='AbortError') console.warn('Crop preload unavailable',error);}
  })();
  return entry.promise;
}
async function warmReviewImages() {
  if(!isContinuousReview()) return;
  await Promise.all(pool.slice(maxReachedIdx,maxReachedIdx+REVIEW_PREFETCH+1).map(preloadReviewImage));
}

function isContinuousReview() { return queueMode && reviewBatch?.mode === 'stream'; }
let collectionItems = [], collectionCursor = null, collectionNextCursor = null, collectionPrevious = [];
let queueRequest = 0, reviewBatchRequest = 0, queueLoading = false, reviewBatchLoading = false, queueCommitBusy = false, labelingEntryBusy = false;
function resetQueueState() {
  legacyReviewDrafts.clear();
  if(window.CollectorBackgroundLists && frameListEl) { window.CollectorBackgroundLists.clear(frameListEl); frameListEl.classList.remove("instant-list-host"); }
  if(typeof resetFullSessionReview==='function') resetFullSessionReview();
  if(typeof resetAiReview==='function') resetAiReview();
  queueCompletedResult=null;
  streamEpoch++;releaseStreamImages();streamFetch=null;streamAdvancing=false;streamStats=null;streamCheckpointSequence=0;queueRequest++;reviewBatchRequest++;reviewBatchLoading=false;labelingEntryBusy=false;queueMode=false;queueSummary=null;reviewBatch=null;queueCompletedStats={items:0,time:0};queueLastCommitReceipt=null;queueCompletionRecorded=false;
  collectionItems=[];collectionCursor=null;collectionNextCursor=null;collectionPrevious=[];
}
function applyQueueSummary(summary) {
  if(Number.isInteger(summary?.revision) && Number.isInteger(queueSummary?.revision) && summary.revision<queueSummary.revision) return;
  if (summary && Number.isInteger(summary.total)) queueSummary={...summary};
  updateQueueControls();
}
function applyCollectionPage(page) {
  if (!page || !Array.isArray(page.items)) return;
  collectionItems=page.items.slice(0,COLLECTION_PAGE_SIZE);
  collectionNextCursor=page.next_cursor ?? null;
  applyQueueSummary(page.summary);
}
async function loadCollectionPage(cursor = null, direction = 'refresh') {
  if (!queueMode) return;
  if(window.CollectorBackgroundLists) { await window.CollectorBackgroundLists.invalidate("/api/queue",activeDatasetId);return; }
  const token=++queueRequest,epoch=datasetEpoch,previous=collectionCursor;
  queueLoading=true;updateQueueControls();
  try {
    const query=new URLSearchParams({limit:String(COLLECTION_PAGE_SIZE),order:'newest'});
    if (cursor !== null && cursor !== '') query.set('cursor',String(cursor));
    const page=await (await datasetFetch(`/api/queue?${query}`)).json();
    if(token!==queueRequest || epoch!==datasetEpoch) return;
    if(cursor && !page.items?.length && page.summary?.total) {await loadCollectionPage();return;}
    if(direction==='next') collectionPrevious.push(previous);
    else if(direction==='previous') collectionPrevious.pop();
    else if(cursor===null) collectionPrevious=[];
    collectionCursor=cursor;applyCollectionPage(page);renderFrames();
  } finally { if(token===queueRequest) {queueLoading=false;updateQueueControls();} }
}
async function loadReviewBatch(cursor = null) {
  if (!queueMode || reviewBatchLoading) return false;
  const token=++reviewBatchRequest;
  reviewBatchLoading=true;queueLoading=true;updateQueueControls();
  try {
    const data=await (await datasetFetch('/api/queue/review/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
    if(token!==reviewBatchRequest) return false;
    const session=data.session || {};
    streamCheckpointSequence=Math.max(streamCheckpointSequence,session.checkpoint_sequence || 0);
    leaveReviewClock();clearModelTextTransition();modelRequest++;
    streamEpoch++;releaseStreamImages();streamFetch=null;
    pool=session.pool || data.items || [];reviewBatch=session.review_batch || data.review_batch || null;
    currentReviewIdx=session.currentReviewIdx || 0;maxReachedIdx=session.maxReachedIdx || currentReviewIdx;
    streamStats=session.review_stats || data.review_stats || null;
    selectedPoolIndices.clear();pruneStreamCaches();applyQueueSummary(data.summary || session.queue_summary);
    await warmReviewImages();
    return pool.length>0;
  } finally {if(token===reviewBatchRequest) {reviewBatchLoading=false;queueLoading=false;updateQueueControls();}}
}
function pruneStreamCaches() {
  const keys=new Set(pool.map(sampleKey));
  releaseStreamImages(keys);
  reviewAwards=Object.fromEntries(Object.entries(reviewAwards).filter(([key])=>keys.has(key)));
  // Name/currency knowledge is small text-only domain state, not retained crops.
  // Keep it across eviction so autocomplete and discovery bonuses stay correct.
}
function trimReviewHistory() {
  if(!isContinuousReview()) return;
  const drop=Math.max(0,maxReachedIdx-REVIEW_HISTORY);
  if(drop) {
    pool.splice(0,drop);currentReviewIdx-=drop;maxReachedIdx-=drop;
    reviewBatch.legacy_offset=(reviewBatch.legacy_offset || 0)+drop;
    selectedPoolIndices.clear();pruneStreamCaches();
  }
  reviewBatch.keys=pool.map(sampleKey);
}
async function prefetchReview(force = false) {
  if(!isContinuousReview() || !reviewBatch.next_cursor) return;
  if(streamFetch) return streamFetch;
  const ahead=pool.length-1-maxReachedIdx;
  if(!force && ahead>2) return;
  const count=Math.min(REVIEW_PREFETCH,REVIEW_PREFETCH-ahead);
  if(count<=0) return;
  const epoch=streamEpoch,runId=reviewBatch.batch_id,cursor=reviewBatch.next_cursor;
  const request=(async()=>{
    const query=new URLSearchParams({run_id:runId,cursor,limit:String(count)});
    const data=await (await datasetFetch('/api/queue/review/next?'+query)).json();
    if(epoch!==streamEpoch || runId!==reviewBatch?.batch_id) return;
    const existing=new Set(pool.map(sampleKey));
    const incoming=(data.items || []).filter(item=>!existing.has(sampleKey(item)));
    pool.push(...incoming);reviewBatch.next_cursor=data.next_cursor || null;
    reviewBatch.keys=pool.map(sampleKey);streamStats=data.review_stats || streamStats;
    applyQueueSummary(data.summary);await warmReviewImages();await saveSessionProgress(true);
  })();
  streamFetch=request;
  try {await request;} finally {if(streamFetch===request) streamFetch=null;}
}
async function finishContinuousReview() {
  if(!isContinuousReview()) return showLabelingStats();
  await saveSessionProgress(true);
  const query=new URLSearchParams({run_id:reviewBatch.batch_id});
  const data=await (await datasetFetch('/api/queue/review/stats?'+query)).json();
  streamStats=data.review_stats || streamStats;
  if(streamStats?.pending>0) throw new Error('Some collection crops still need review. Reload labeling to continue.');
  updateStepperButtons();
  await showLabelingStats();
}
async function advanceContinuousReview() {
  if(streamAdvancing) return;
  streamAdvancing=true;
  try {
    const item=pool[currentReviewIdx];
    if(!item || !(item.reviewed || item.discarded || item.label)) return;
    if(currentReviewIdx===pool.length-1 && reviewBatch.next_cursor) {
      freezeReviewClock('loading');
      try {await prefetchReview(true);} finally {resumeReviewClock('loading');}
    }
    if(currentReviewIdx<pool.length-1) {
      leaveReviewClock();currentReviewIdx++;maxReachedIdx=Math.max(maxReachedIdx,currentReviewIdx);
      trimReviewHistory();await preloadReviewImage(pool[currentReviewIdx]);setView('labeling');
      void prefetchReview().catch(error=>showToast(error.message,'error'));
    } else if(!reviewBatch.next_cursor) await finishContinuousReview();
  } catch(error) {showToast(error.message,'error');}
  finally {streamAdvancing=false;}
}
function updateQueueControls() {
  updateLabelingEntryControls();
  const pager=document.getElementById('collection-pagination');
  if(pager) pager.classList.toggle('hidden',!!window.CollectorBackgroundLists || !queueMode || !queueSummary?.total);
  const previous=document.getElementById('collection-previous'),nextPage=document.getElementById('collection-next');
  if(previous) previous.disabled=queueLoading || !collectionPrevious.length;
  if(nextPage) nextPage.disabled=queueLoading || !collectionNextCursor;
  const position=document.getElementById('collection-page-position');
  if(position && queueMode) position.textContent=`${collectionItems.length} shown · ${(queueSummary?.pending || 0).toLocaleString()} waiting`;
  const saveAll=document.getElementById('btn-add-db');
  if(saveAll) {saveAll.textContent=isContinuousReview()?`Save all ${(streamStats?.total || reviewBatch.total_at_start || 0).toLocaleString()} crops`:'Commit to database';saveAll.title=isContinuousReview()?'Saves the entire reviewed collection, including crops unloaded from this window.':'';
    saveAll.disabled=queueCommitBusy || reviewSaving || !!(typeof fullSessionReview!=='undefined' && fullSessionReview?.mutation) || !!(typeof isAiReviewBusy==='function' && isAiReviewBusy());}
  const recentSearch=document.getElementById('review-search');
  if(recentSearch) recentSearch.placeholder=isContinuousReview()?'Search all session crops…':'Search ID or Label...';
  const title=document.getElementById('stats-completion-title');
  if(title) title.textContent='SESSION COMPLETE';
  const nextBatch=document.getElementById('btn-next-batch');
  if(nextBatch) {
    nextBatch.classList.add('hidden');
    nextBatch.disabled=queueLoading || queueCommitBusy || reviewSaving || !pool.length || !pool.every(item=>item.reviewed || item.discarded);
    nextBatch.textContent='Save batch & continue';
  }
}
function updateLabelingEntryControls() {
  const availability = workflowAvailability();
  const button = document.getElementById('btn-label-regions');
  if (button) button.disabled = !availability.startLabeling;
  const navigation = document.getElementById('nav-labeling');
  if (navigation) navigation.disabled = !availability.navigateLabeling;
}
async function beginLabeling() {
  if (queueLoading || reviewBatchLoading || queueCommitBusy || labelingEntryBusy || reviewSaving || datasetSwitching || isRecovering) return;
  const epoch = datasetEpoch;
  labelingEntryBusy = true; updateLabelingEntryControls();
  try {
    await stopAndRecoverWatch('Ready to label');
    if (epoch !== datasetEpoch || datasetSwitching) return;
    if (queueMode && (!pool.length || !isContinuousReview())) await loadReviewBatch();
    if (epoch !== datasetEpoch || datasetSwitching) return;
    if (!queueMode && !pool.length) processPool();
    if (!pool.length) {if(!reviewBatch && queueSummary?.total===0) return;showToast('No new unique regions to label.', 'error');return;}
    labelingUnlocked = true;
    if (queueMode && !isContinuousReview() && pool.every(item => item.reviewed || item.discarded)) {
      reviewUnlocked = true; setView('session-review');
    } else setView('labeling');
  } catch (error) { showToast(error.message, 'error'); }
  finally { if (epoch === datasetEpoch) labelingEntryBusy = false; updateStepperButtons(); }
}
async function commitContinuousReview() {
  if(queueCommitBusy || reviewSaving || streamAdvancing || (typeof fullSessionReview!=='undefined' && fullSessionReview?.mutation) || (typeof isAiReviewBusy==='function' && isAiReviewBusy())) return;
  queueCommitBusy=true;queueLoading=true;updateQueueControls();showLoading(true,'Saving reviewed collection…');
  try {
    await stopCaptureWatch('Saving reviewed collection');
    try {await saveSessionProgress(true);} catch(error) {if(!/Review batch changed/i.test(error.message)) throw error;}
    const data=await (await datasetFetch('/api/queue/review/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({run_id:reviewBatch.batch_id})})).json();
    if(!data.success) throw new Error(data.error || 'Collection could not be saved');
    leaveReviewClock();clearModelTextTransition();modelRequest++;streamEpoch++;releaseStreamImages();streamFetch=null;
    pool=[];frames=[];reviewBatch=null;reviewAwards={};streamStats=null;currentReviewIdx=0;maxReachedIdx=0;
    labelingUnlocked=false;reviewUnlocked=false;queueCompletedStats={items:0,time:0};queueCompletionRecorded=false;queueCompletedResult=null;
    applyQueueSummary(data.summary);await loadCollectionPage();await refreshDatabase();
    setView('collection');await saveSessionProgress(true);showToast('Reviewed collection saved.','success');
  } catch(error) {showToast(error.message,'error');}
  finally {queueCommitBusy=false;queueLoading=false;showLoading(false);updateQueueControls();}
}
async function commitQueueBatch(continueReview = false) {
  if(isContinuousReview()) return commitContinuousReview();
  if(queueLoading || queueCommitBusy || reviewSaving) return;
  const selected=pool.filter(item=>item.reviewed || item.discarded);
  const continuation=reviewBatch?.next_cursor || null;
  if(selected.length!==pool.length || !selected.length) {showToast('Finish this batch before saving.','error');return;}
  queueCommitBusy=true;
  queueLoading=true;updateQueueControls();showLoading(true,'Saving reviewed batch…');
  try {
    await stopCaptureWatch('Saving reviewed batch');
    try {await saveSessionProgress(true);} catch(error) {
      // An earlier commit may have succeeded while its response was lost. The
      // authoritative idempotent commit receipt resolves that exact selection.
      if(!/Review batch changed/i.test(error.message)) throw error;
    }
    const data=await (await datasetFetch('/api/queue/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_keys:selected.map(sampleKey)})})).json();
    if(!data.success) throw new Error(data.error || 'Batch could not be saved');
    const receipt=data.commit_receipt?.id;
    const finalBatch=data.summary?.total===0;
    if(finalBatch && !queueCompletionRecorded && sessionScore>0) await showLabelingStats();
    const timed=selected.filter(item=>!item.discarded && Number.isFinite(item.labelTime));
    if(!finalBatch && (!receipt || receipt!==queueLastCommitReceipt)) queueCompletedStats={items:queueCompletedStats.items+timed.length,time:queueCompletedStats.time+timed.reduce((sum,item)=>sum+item.labelTime,0)};
    if(receipt) queueLastCommitReceipt=receipt;
    if(finalBatch) {queueCompletedStats={items:0,time:0};queueCompletionRecorded=false;queueCompletedResult=null;}
    leaveReviewClock();clearModelTextTransition();modelRequest++;
    pool=[];frames=[];reviewBatch=null;reviewAwards={};currentReviewIdx=0;maxReachedIdx=0;
    labelingUnlocked=false;reviewUnlocked=false;selectedPoolIndices.clear();
    applyQueueSummary(data.summary);await loadCollectionPage();
    await refreshDatabase();
    if(continueReview && await loadReviewBatch(continuation)) {
      labelingUnlocked=true;
      if(pool.every(item=>item.reviewed || item.discarded)) {reviewUnlocked=true;setView('session-review');}
      else setView('labeling');
    }
    else {setView('collection');showToast('Reviewed batch saved.','success');}
    await saveSessionProgress(true);
  } catch(error) {showToast(error.message,'error');}
  finally {queueCommitBusy=false;queueLoading=false;showLoading(false);updateQueueControls();}
}
async function discardQueue(selection) {
  if(!queueMode) return;
  try {
    const oldIndex=currentReviewIdx,key=pool[currentReviewIdx] && sampleKey(pool[currentReviewIdx]);
    const data=await (await datasetFetch('/api/queue/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(selection)})).json();
    const keys=new Set(selection.sample_keys || []),ids=new Set(selection.frame_ids || []);
    pool=pool.filter(item=>!selection.clear && !keys.has(sampleKey(item)) && !ids.has(item.frame_id || item.watch_frame_id));
    if(reviewBatch) reviewBatch={...reviewBatch,keys:pool.map(sampleKey)};
    const retainedIndex=pool.findIndex(item=>sampleKey(item)===key);
    currentReviewIdx=retainedIndex>=0 ? retainedIndex : Math.min(oldIndex,Math.max(0,pool.length-1));
    maxReachedIdx=Math.min(maxReachedIdx,Math.max(0,pool.length-1));
    applyQueueSummary(data.summary);if(currentView==='collection') await loadCollectionPage();await saveSessionProgress(true);
    updateStepperButtons();
    return true;
  } catch(error) {showToast(error.message,'error');return false;}
}
let dbPage = 1, dbPageSize = 250, dbTotal = 0, dbSelectedMetadata = new Map(), dbDrafts = new Map();
async function refreshDatabase() {
  if(window.CollectorBackgroundLists) { await window.CollectorBackgroundLists.invalidate("/api/db_entries",activeDatasetId);lastNamesQuery=""; await refreshNames(""); return; }
  const response=await datasetFetch("/api/db_entries");loadDatabase(await response.json());
}
let namesRequest=0, nativeNameSuggestions=[];
async function refreshNames(search) {
  if(!window.CollectorBackgroundLists || !activeDatasetId) return;
  const epoch=datasetEpoch, datasetId=activeDatasetId, request=++namesRequest;
  try { const result=await window.CollectorBackgroundLists.readPages("/api/name_suggestions",datasetId,{search},"names",false);
    if(epoch!==datasetEpoch || datasetId!==activeDatasetId || request!==namesRequest || (search && labelInput?.value!==search)) return;
    nativeNameSuggestions=result.items.map(item=>item.name);
    if(pool[currentReviewIdx]?.id?.includes("name") && labelInput?.value===search) updateAutocomplete();
  } catch(error) { if(epoch===datasetEpoch) console.warn("Name suggestions unavailable",error); }
}
let gameCurrencyMap = {};
let currentSuggestion = "", currentView = 'collection', isRecovering = true, isTabbing = false;
let sessionScore = 0, currentCombo = 0, maxCombo = 0, quickLabels = 0, autoCompletes = 0;
let usedAutoComplete = false;
let dbSuggestionRequest = 0, dbReviewSaving = false;
let reviewAwards = {};
let reviewClock = {key:null, state:null};
let selectedFiles = new Set(), selectedPoolIndices = new Set(), editingPoolIdx = -1;
let lastValue = "";
let actionHistory = []; // { type: 'typing' | 'tab' | 'delete', points: number, value: string }
let highscoreAdded = false;
let globalHistory = [], completionHistoryRequest=0;
async function refreshCompletionHistory(session, lookup) {
  if(!window.CollectorBackgroundLists) { globalHistory=await (await datasetFetch('/api/get_session_history')).json();return; }
  const epoch=datasetEpoch,datasetId=activeDatasetId,request=++completionHistoryRequest,stats=session?.review_stats || streamStats;
  const pending=session ? (!!session.queueCompletionRecorded && !session.queueCompletedResult) || !!(session.queueCompletedResult && !session.queueCompletedResult.history_saved) : (!!queueCompletionRecorded && !queueCompletedResult) || !!(queueCompletedResult && !queueCompletedResult.history_saved);
  const rows=await window.CollectorBackgroundLists.historySummary(datasetId,session?.review_batch?.batch_id || reviewBatch?.batch_id || null,stats?.items>0 && stats?.time>0 ? {items:stats.items,time:stats.time} : null,lookup ?? pending);
  if(epoch!==datasetEpoch || datasetId!==activeDatasetId || request!==completionHistoryRequest) throw new Error('History refresh superseded.');
  globalHistory=rows;
}
let maxReachedIdx = 0;
let currentValidationError = null;
let isPaused = false;
let pauseStartTime = 0;
let labelingUnlocked = false;
let reviewUnlocked = false;





// DOM References
let monitorSelect, frameListEl, sessionReviewListEl, dbListEl;
let viewCollection, viewLabeling, viewSessionReview, viewDatabase, viewLabelingStats;
let labelInput, inputGroup, ghostText;

function initDom() {
  const header = document.querySelector('header');
  if (header) {
    const syncHeaderHeight = () => document.documentElement.style.setProperty('--collector-header-height', `${header.getBoundingClientRect().height}px`);
    syncHeaderHeight();
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncHeaderHeight).observe(header);
  }
  monitorSelect = document.getElementById("monitor-select");
  frameListEl = document.getElementById("frame-list");
  sessionReviewListEl = document.getElementById("session-review-list");
  dbListEl = document.getElementById("db-list");
  viewCollection = document.getElementById("view-collection");
  viewLabeling = document.getElementById("view-labeling");
  viewSessionReview = document.getElementById("view-session-review");
  viewDatabase = document.getElementById("view-database");
  viewLabelingStats = document.getElementById("labeling-stats-card");
  labelInput = document.getElementById("label-input");
  inputGroup = document.getElementById("input-group");
  ghostText = document.getElementById("ghost-text");

  // --- Event Listeners ---

  monitorSelect.onchange = async () => {
    updateMonitorTitle();
    await stopAndRecoverWatch('Capture source changed');
    await datasetFetch("/api/save_settings", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ last_monitor: monitorSelect.value })
    });
  };

  document.getElementById("btn-clear-frames").onclick = async () => {
    try { await stopAndRecoverWatch('Collection paused'); } catch(error) { showToast(error.message,'error');return; }
    if (await showConfirmModal("Clear Session", "Are you sure you want to clear all captured frames? This cannot be undone.")) {
      await stopCaptureWatch('Session cleared'); watchNeedsRecovery = false;
      if(queueMode) {
        const result=await (await datasetFetch('/api/queue/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear:true})})).json();
        collectionItems=[];collectionCursor=null;collectionNextCursor=null;collectionPrevious=[];reviewBatch=null;applyQueueSummary(result.summary);
        queueCompletedStats={items:0,time:0};queueLastCommitReceipt=null;queueCompletionRecorded=false;
      } else await datasetFetch("/api/clear_session", {method: "POST"});
      datasetEpoch++; modelRequest++; dbSuggestionRequest++; reviewSaving = false; dbReviewSaving = false;
      frames = []; pool = []; gameCurrencyMap = {};
              currentReviewIdx = 0;
              labelingUnlocked = false; reviewUnlocked = false;
              sessionScore = 0; currentCombo = 0; maxCombo = 0; quickLabels = 0; autoCompletes = 0; reviewAwards = {}; resetReviewClock();
              highscoreAdded = false; maxReachedIdx = 0;
              updateScoreDisplay();renderFrames();await saveSessionProgress(true);
    }  };

  labelInput.onbeforeinput = (e) => {
    const item = pool[currentReviewIdx];
    if (!item) return;
    const schema = SchemaRegistry.getSchema(item.id);

    // Calculate proposed value
    let proposed = "";
    if (e.inputType === "insertText" || e.inputType === "insertFromPaste") {
      const text = e.data || (e.clipboardData ? e.clipboardData.getData('text') : "");
      if (!text) return;
      proposed = labelInput.value.slice(0, labelInput.selectionStart) + text + labelInput.value.slice(labelInput.selectionEnd);
    } else return;

    // 1. Check strict partial match
    if (schema.isPartial(proposed)) return;

    // 2. Prefix Override Mechanism (Exceptions)
    const typed = e.data;
    if (typed && typed.length === 1) {
      const v = typed.toLowerCase();

      // Currency Auto-Correction: 'g' -> 'G ', 's' -> 'S '
      const isMoneySchema = item.id.includes("bet") || item.id.includes("bank") || item.id.includes("pot");
      if (isMoneySchema) {
        // Special case: 'Pot: ' prefix for POT schema
        const isPotPrefix = item.id.includes("pot") && !item.id.includes("split");
        const currentVal = labelInput.value;
        const atStart = isPotPrefix ? (currentVal === "Pot: ") : (currentVal === "");

        if (atStart && (v === 'g' || v === 's')) {
          e.preventDefault();
          const corrected = v.toUpperCase() + " ";
          if (isPotPrefix) {
            labelInput.value = "Pot: " + corrected;
          } else {
            labelInput.value = corrected;
          }
          const event = new Event('input', { bubbles: true });
          labelInput.dispatchEvent(event);
          return;
        }
      }

      // Card Rank Auto-Correction: 'a' -> 'A', etc.
      if (schema === Schemas.CARD && ['a', 'j', 'q', 'k'].includes(v)) {
        e.preventDefault();
        labelInput.value = labelInput.value.slice(0, labelInput.selectionStart) + v.toUpperCase() + labelInput.value.slice(labelInput.selectionEnd);
        const event = new Event('input', { bubbles: true });
        labelInput.dispatchEvent(event);
        return;
      }

      // Bank Override: 'A' -> start of 'All-In'
      if (item.id.includes("bank") && v === 'a') {        e.preventDefault();
        labelInput.value = "A";
        // Trigger manual input update logic
        const event = new Event('input', { bubbles: true });
        labelInput.dispatchEvent(event);
        return;
      }

      // Pot Override: 'R' -> start of 'Run It Twice pause ('
      if (item.id.includes("pot") && v === 'r') {
        e.preventDefault();
        labelInput.value = "R";
        const event = new Event('input', { bubbles: true });
        labelInput.dispatchEvent(event);
        return;
      }
    }

    // 3. Block invalid keystroke
    e.preventDefault();
  };

  labelInput.oninput = (e) => {
    const item = pool[currentReviewIdx]; if (!item || reviewSaving || isPaused) return;
    const schema = SchemaRegistry.getSchema(item.id);
    const t = labelInput.value;
    const multiplier = getComboMultiplier(currentCombo);

    // Passive validation (no mutation)
    const { isValid } = schema.validate(t, item);
    const isPrefix = schema.isPartial(t, item);
    const isAcceptable = isValid || isPrefix;

    // Award points based on text change
    if (e.inputType === "insertText" || e.inputType === "insertFromPaste") {
      if (!isTabbing) {
        const insertedLen = t.length - lastValue.length;
        if (insertedLen > 0 && isAcceptable) {
          const pts = 5 * multiplier * insertedLen;
          sessionScore += pts;
          updateScoreDisplay();
          const char = e.data || t.slice(-1);
          showFloatingScore(pts, 'typing', { char });
          actionHistory.push({ type: 'typing', points: pts, multiplier: multiplier, len: insertedLen });
        }
      }
    } else if (e.inputType && e.inputType.startsWith("delete")) {
      const deletedCount = lastValue.length - t.length;
      if (deletedCount > 0) {
        const penalty = deletedCount * 10 * multiplier;
        sessionScore = Math.max(0, sessionScore - penalty);
        updateScoreDisplay();
        showFloatingScore(-penalty, 'delete');
        actionHistory.push({ type: 'delete', len: deletedCount, multiplier: multiplier });
      }
    } else if (e.inputType === "historyUndo") {
      let charDiff = lastValue.length - t.length;
      while (Math.abs(charDiff) > 0 && actionHistory.length > 0) {
        const lastAction = actionHistory.pop();
        if (lastAction.type === 'typing' && charDiff > 0) {
          const penalty = 10 * lastAction.multiplier * lastAction.len;
          sessionScore = Math.max(0, sessionScore - penalty);
          showFloatingScore(-penalty, 'delete');
          charDiff -= lastAction.len;
        } else if (lastAction.type === 'tab' && charDiff > 0) {
          const penalty = lastAction.points * 2;
          sessionScore = Math.max(0, sessionScore - penalty);
          showFloatingScore(-penalty, 'delete');
          charDiff -= lastAction.len;
        } else if (lastAction.type === 'delete' && charDiff < 0) {
          charDiff += lastAction.len;
        } else break;
      }
      updateScoreDisplay();
    }

    lastValue = t;
    const curMatch = t.match(/[GS] /); 
    if (curMatch) gameCurrencyMap[item.game_id] = curMatch[0].trim();
    
    persistReviewDraft();
    
    validateInput(); 
    updateAutocomplete();
  };

  document.getElementById("review-search").oninput = renderSessionReview;
  const reviewFilter=document.getElementById('review-filter');
  if(reviewFilter) reviewFilter.onchange=renderSessionReview;
  document.getElementById("db-search").oninput = () => { dbPage = 1; renderDatabase(); };
  document.getElementById("btn-db-prev").onclick = () => { if (dbPage > 1) { dbPage--; renderDatabase(); } };
  document.getElementById("btn-db-next").onclick = () => {
    const search = document.getElementById("db-search").value.toLowerCase();
    const filtered = dbEntries.filter(e => e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search)));
    const totalPages = Math.ceil(filtered.length / dbPageSize);
    if (dbPage < totalPages) { dbPage++; renderDatabase(); }
  };

  document.getElementById("btn-db-stats").onclick = toggleDbStats;
  document.getElementById("btn-db-back").onclick = toggleDbStats;

  document.getElementById("btn-db-deselect-all").onclick = () => {
    selectedFiles.clear();dbSelectedMetadata.clear();
    renderDatabase();
  };

  document.getElementById("btn-review-bulk-label").onclick = () => handleBulkLabel('review');
  document.getElementById("btn-db-bulk-label").onclick = () => handleBulkLabel('database');

  document.getElementById("review-bulk-label-input").oninput = () => {
    if(typeof isFullSessionReview==='function' && isFullSessionReview()) {updateReviewBulkUI();return;}
    const bulkInput = document.getElementById("review-bulk-label-input");
    document.getElementById("btn-review-bulk-label").disabled = bulkInput.value.trim() === "" || selectedPoolIndices.size < 2;
  };

  document.getElementById("db-bulk-label-input").oninput = () => {
    const bulkInput = document.getElementById("db-bulk-label-input");
    document.getElementById("btn-db-bulk-label").disabled = bulkInput.value.trim() === "" || selectedFiles.size < 2;
  };

  document.getElementById("btn-review-select-all").onclick = () => {
    if(typeof isFullSessionReview==='function' && isFullSessionReview()) {selectFullReviewShown();return;}
    const search = document.getElementById("review-search").value.toLowerCase();
    const applicable=pool.map((e,idx)=>({e,idx})).filter(({e})=>e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search)));
    const all=applicable.length>0 && applicable.every(({idx})=>selectedPoolIndices.has(idx));
    for(const {idx} of applicable) all ? selectedPoolIndices.delete(idx) : selectedPoolIndices.add(idx);
    renderSessionReview();
  };

  document.getElementById("btn-db-select-all").onclick = async () => {
    if(window.CollectorBackgroundLists) {
      const epoch=datasetEpoch,datasetId=activeDatasetId,search=document.getElementById("db-search").value.trim();
      try { const result=await window.CollectorBackgroundLists.readPages("/api/db_entries",datasetId,{search},"database",true);
        if(epoch!==datasetEpoch || datasetId!==activeDatasetId || search!==document.getElementById("db-search").value.trim()) return;
        for(const item of result.items) {selectedFiles.add(item.filename);dbSelectedMetadata.set(item.filename,item);if(!dbEntries.some(entry=>entry.filename===item.filename)) dbEntries.push(item);} renderDatabase();
      } catch(error) {showToast(`Could not select all crops: ${error.message}`,'error');} return;
    }
    const search = document.getElementById("db-search").value.toLowerCase();
    dbEntries.forEach(e => {
      if (e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search))) {
        selectedFiles.add(e.filename);
      }
    });
    renderDatabase();
  };

  document.getElementById("btn-delete-session-selected").onclick = async () => {
    if(typeof isFullSessionReview==='function' && isFullSessionReview()) {await removeFullSessionItems();return;}
    if (!selectedPoolIndices.size) return;
    if (await showConfirmModal("Remove Selected", `Remove ${selectedPoolIndices.size} selected items from this session?`)) {
      const indices = Array.from(selectedPoolIndices).sort((a, b) => b - a);
      if(queueMode) {await discardQueue({sample_keys:indices.map(idx=>sampleKey(pool[idx]))});selectedPoolIndices.clear();renderSessionReview();return;}
      const watchKeys = indices.filter(idx => pool[idx]?.watch).map(idx => sampleKey(pool[idx]));
      if (watchKeys.length) {
        try { await datasetFetch('/api/watch/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_keys:watchKeys})}); }
        catch (error) { showToast(error.message,'error'); return; }
      }
      indices.forEach(idx => {
        const item = pool[idx];
        pool.splice(idx, 1);
        prunePoolsForItem(item);
      });
      selectedPoolIndices.clear();
      saveSessionProgress();
      renderSessionReview();
      updateStepperButtons();
    }
  };

  document.getElementById("btn-delete-db-selected").onclick = async () => {
    if (!selectedFiles.size) return;
    if (await showConfirmModal("Remove from Database", `Permanently remove ${selectedFiles.size} selected entries from database? This action is IRREVERSIBLE.`)) {
      const filenames=Array.from(selectedFiles),epoch=datasetEpoch;let d,removed=0;
      try {
        for(let offset=0;offset<filenames.length;offset+=100) {const batch=filenames.slice(offset,offset+100),r=await datasetFetch("/api/db_delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filenames:batch})});if(!r.ok) throw new Error("Could not remove selected crops");d=await r.json();for(const filename of batch){selectedFiles.delete(filename);dbSelectedMetadata.delete(filename);}removed+=batch.length;}
        showToast(d?.message || "Crops removed", "success");
      } catch(error) {if(epoch===datasetEpoch) showToast(`${error.message}; ${removed} crops removed. Remaining crops stay selected.`,"error");}
      finally {if(epoch===datasetEpoch) {await refreshDatabase();renderDatabase();}}
    }
  };

  document.getElementById("btn-db-clear").onclick = async () => {
    if (await showConfirmModal("Clear Database", "Are you sure you want to permanently delete ALL entries, including full captures? This is IRREVERSIBLE.")) {
      showLoading(true, "Clearing Database...");
      const r = await datasetFetch("/api/db_clear", { method: "POST" });
      const d = await r.json();
      showToast(d.message, "success");
      dbEntries = [];dbTotal=0;selectedFiles.clear();dbSelectedMetadata.clear();
      if(window.CollectorBackgroundLists) await refreshDatabase();
      renderDatabase();
      updateStepperButtons();
      showLoading(false);
    }
  };

  const btnLabelRegions = document.getElementById("btn-label-regions");
  if (btnLabelRegions) {
    btnLabelRegions.onclick = beginLabeling;
  }

  const btnStatsReview = document.getElementById("btn-stats-review");
  if (btnStatsReview) {
    btnStatsReview.onclick = () => {
      reviewUnlocked = true;
      setView('session-review');
      updateStepperButtons();
    };
  }

  for(const [id,path] of [["nav-collection","/api/queue"],["nav-session-review","/api/queue/review/items"]]) {
    const prefetch=()=>{if(!window.CollectorBackgroundLists || !queueMode || (path.includes("review") && !reviewBatch?.batch_id)) return;
      const query=path.includes("review") ? {run_id:reviewBatch.batch_id,...fullReviewQuery()} : {order:"newest"};
      window.CollectorBackgroundLists.prefetch({path,datasetId:activeDatasetId,query,key:sampleKey,card:()=>document.createElement("div"),changed:()=>{}});
    };
    document.getElementById(id)?.addEventListener("mouseenter",prefetch);document.getElementById(id)?.addEventListener("focus",prefetch);
  }
  document.getElementById("nav-collection").onclick = () => setView('collection');
  document.getElementById("nav-labeling").onclick = beginLabeling;
  document.getElementById("nav-session-review").onclick = () => setView('session-review');
  document.getElementById("nav-database").onclick = () => setView('database');

  document.getElementById("btn-add-db").onclick = async () => {
    if(typeof fullSessionReview!=='undefined' && fullSessionReview?.mutation) return;
    if(typeof isAiReviewBusy==='function' && isAiReviewBusy()) return;
    if(queueMode) {await commitQueueBatch(false);return;}
    await stopCaptureWatch("Committing dataset");
    const ae = pool; if (!ae.length) { showToast("No active regions."); return; }
    showLoading(true, "Committing to Database...");
    const scrubbed = ae.map(p => ({...p, label: p.discarded ? "" : p.label}));
    try {
      const r = await datasetFetch("/api/add_to_db", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({entries: scrubbed})
      });
      const d = await r.json();
      if (d.success) {
        datasetEpoch++; modelRequest++; dbSuggestionRequest++; reviewSaving = false; dbReviewSaving = false;
        showToast(d.message, "success");
        frames = []; pool = []; gameCurrencyMap = {};
        currentReviewIdx = 0; maxReachedIdx = 0;
        labelingUnlocked = false; reviewUnlocked = false;
        sessionScore = 0; currentCombo = 0; maxCombo = 0; quickLabels = 0; autoCompletes = 0; reviewAwards = {}; resetReviewClock();
        highscoreAdded = false;
        updateScoreDisplay();
        renderFrames();
        updateStatusBar();        await refreshDatabase();
        setView('database');
      } else {
        showToast("Error: " + d.error, "error");
      }
    } catch (e) {
      showToast("Network Error: " + e.message, "error");
    } finally {
      showLoading(false);
    }
  };

  window.onkeydown = (e) => {
    if (window.location?.pathname === '/gameplay' || datasetSwitching || e.defaultPrevented || document.getElementById('modal-overlay')?.classList.contains('active')) return;
    if (currentView === 'collection') {
      const keys=window.CollectorSharedUi.recordingKeys;
      const command=keys.resolveKey(e,{...keys.targetContext(e.target),collection:true,
        modalOpen:false,popoverOpen:!!document.querySelector('#view-collection details[open], [data-recording-source-open="true"], #dataset-manager[open], [role="menu"]'),
        recording:!!captureWatch?.isActive(),captureBusy:manualCaptureBusy || !!captureWatch?.isBusy(),previewActive:!!document.querySelector('.capture-arrival')});
      if (command) {
        e.preventDefault();
        if (command === 'capture') void captureFrame();
        else if (command === 'toggle') {
          if (captureWatch?.isActive() || captureWatch?.isBusy()) void stopAndRecoverWatch('Recording paused').catch(error => showToast(error.message,'error'));
          else document.getElementById('watch-start').click();
        } else void stopAndRecoverWatch('Recording stopped').catch(error => showToast(error.message,'error'));
      }
      return;
    }
    const editing = e.target.matches?.('input, textarea, select, button, summary');
    if (editing && e.target !== labelInput && !['model-use','model-accept','model-retry','label-save'].includes(e.target.id)) return;
    if (currentView === 'labeling' && !viewLabelingStats.classList.contains('hidden')) return;
    if (currentView === 'labeling' && reviewSaving && e.key !== 'Escape') {e.preventDefault();return;}
    if (currentView === 'labeling' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (!e.repeat && !e.isComposing) void deleteCurrentCrop();
      return;
    }
    const acceptPrediction = e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'Enter';
    const editPrediction = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'Tab';
    if (currentView === 'labeling' && (acceptPrediction || editPrediction)) {
      e.preventDefault();
      if (e.repeat || isPaused) return;
      if (acceptPrediction) acceptModelSuggestion(); else useModelSuggestion();
      return;
    }
    if (editing && e.target !== labelInput) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      if (!viewLabeling.classList.contains("hidden") && viewLabelingStats && viewLabelingStats.classList.contains("hidden")) {
        if (e.key === "[") prev();
        else next();
      }
      return;
    }

    if (!viewLabeling.classList.contains("hidden")) {
      const typed = labelInput.value;
      const item = pool[currentReviewIdx];
      if (!item) return;
      const schema = SchemaRegistry.getSchema(item.id);

      if (isPaused && e.key !== "Escape") {
        e.preventDefault();
        return;
      }

      if (e.key === "Tab") {
        isTabbing = true;
        e.preventDefault();
        if (currentSuggestion) {
          usedAutoComplete = true;
          const result = schema.getSuggestion(typed, item);
          let addedText = "";
          let len = 0;
          if (result && result.type === 'append' && currentSuggestion.startsWith(typed)) {
            addedText = currentSuggestion.slice(typed.length);
            len = addedText.length;
            document.execCommand('insertText', false, addedText);
          } else {
            addedText = currentSuggestion;
            len = Math.max(0, addedText.length - typed.length);
            labelInput.select();
            document.execCommand('insertText', false, addedText);
          }

          const multiplier = getComboMultiplier(currentCombo);
          const pts = Math.round(7.5 * multiplier * len);
          sessionScore += pts;
          updateScoreDisplay();
          showFloatingScore(pts, 'tab');
          actionHistory.push({type:'tab', points:pts, multiplier, len});
          updateAutocomplete();
        }
        isTabbing = false;
        return;
      }
      if (e.key === "Enter") {
        if (e.repeat) { e.preventDefault(); return; }
        saveCurrentAndNext();
        e.preventDefault();
      }
      else if (e.key === "Escape") {
        togglePause();
        e.preventDefault();
      }
      else if (e.key === "Backspace" && (typed === "" || (schema.isAtPrefix && schema.isAtPrefix(typed, item)))) {
        if (currentReviewIdx > 0 && viewLabelingStats && viewLabelingStats.classList.contains("hidden")) {
          prev();
          e.preventDefault();
        }
      }
    }
  };

  initMagnifier();
  initCaptureWatch();
  setInterval(checkComboExpiration, 30);
}

function initMagnifier() {
  const magnifier = document.getElementById("magnifier");
  let isShiftDown = false;
  let lastMouseEvent = null;

  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") {
      isShiftDown = true;
      if (lastMouseEvent) updateMagnifier(lastMouseEvent);
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      isShiftDown = false;
      magnifier.classList.add("hidden");
    }
  });

  window.addEventListener("mousemove", (e) => {
    lastMouseEvent = e;
    updateMagnifier(e);
  });

  function updateMagnifier(e) {
    if (!isShiftDown) {
      magnifier.classList.add("hidden");
      return;
    }

    const target = document.elementFromPoint(e.clientX, e.clientY);
    const card = target?.closest(".card");
    const img = card?.querySelector("img");

    if (!img) {
      magnifier.classList.add("hidden");
      return;
    }

    magnifier.classList.remove("hidden");
    magnifier.style.left = e.clientX + "px";
    magnifier.style.top = e.clientY + "px";

    const fullRes = img.getAttribute("data-full-res") || img.src;
    if (magnifier.style.backgroundImage !== `url("${fullRes}")`) {
      magnifier.style.backgroundImage = `url("${fullRes}")`;
    }

    const rect = img.getBoundingClientRect();
    const padding = 8; // From styles.css (.card img padding)

    // Mouse relative to the content area (inside the 8px padding)
    const cx = (e.clientX - rect.left) - padding;
    const cy = (e.clientY - rect.top) - padding;

    const naturalWidth = img.naturalWidth || 1;
    const naturalHeight = img.naturalHeight || 1;
    const imgRatio = naturalWidth / naturalHeight;

    const contentWidth = rect.width - padding * 2;
    const contentHeight = rect.height - padding * 2;
    const contentRatio = contentWidth / contentHeight;

    let displayWidth, displayHeight, offsetX = 0, offsetY = 0;
    if (imgRatio > contentRatio) {
      displayWidth = contentWidth;
      displayHeight = contentWidth / imgRatio;
      offsetY = (contentHeight - displayHeight) / 2;
    } else {
      displayWidth = contentHeight * imgRatio;
      offsetX = (contentWidth - displayWidth) / 2;
    }

    // We want the magnifier to zoom 2x relative to the original image pixels
    const zoom = 2;
    // Calculate the zoom factor for the entire area
    const areaZoom = (naturalWidth / displayWidth) * zoom;

    magnifier.style.backgroundSize = `${naturalWidth * zoom}px ${naturalHeight * zoom}px`;

    // Position the background so the point (cx, cy) in the content box
    // is exactly at the center (75, 75) of the magnifier.
    // The image itself starts at (offsetX, offsetY) within that content box.
    const bgX = 75 - (cx - offsetX) * areaZoom;
    const bgY = 75 - (cy - offsetY) * areaZoom;

    magnifier.style.backgroundPosition = `${bgX}px ${bgY}px`;
  }
}



function updateMonitorTitle() {
  const selected=monitorSelect?.selectedOptions?.[0];
  if (selected) {
    monitorSelect.title=selected.title || selected.textContent;
    const name=document.getElementById('record-source-name');
    if(name) name.textContent=selected.dataset.shortLabel || selected.textContent;
  }
}
function loadMonitors(sources = [], lastMonitor) {
  monitorSelect.replaceChildren();
  const groups = new Map();
  for (const source of sources) {
    if (!source || typeof source.name !== 'string') continue;
    const kind=source.kind === 'window' ? 'window' : 'monitor';
    let group=groups.get(kind);
    if (!group) {
      group=document.createElement('optgroup');group.label=kind === 'window' ? 'Windows' : 'Monitors';
      groups.set(kind,group);monitorSelect.appendChild(group);
    }
    const option=document.createElement('option');
    const label=source.label || source.title || source.name;
    option.value=source.name;option.textContent=label;
    option.title=source.width && source.height ? `${label} (${source.width}×${source.height})` : label;
    option.dataset.shortLabel=source.kind === 'window' ? (source.app_id || source.app || source.title || label) : label;
    option.dataset.kind=kind;option.selected=source.name === lastMonitor;
    group.appendChild(option);
  }
  // A vanished window must never silently retarget a monitor or another window.
  if (lastMonitor && !Array.from(monitorSelect.options).some(option => option.value === lastMonitor)) {
    const missing=document.createElement('option');missing.value=lastMonitor;missing.textContent='Selected source unavailable';missing.disabled=true;missing.selected=true;missing.dataset.shortLabel='Source unavailable';
    monitorSelect.appendChild(missing);
  }
  if (lastMonitor) monitorSelect.value=lastMonitor;
  updateMonitorTitle();
}
async function refreshCaptureSources() {
  const refresh=document.getElementById('capture-sources-refresh'), captured=captureContext();
  if (refresh) refresh.disabled=true;
  try {
    const data=await (await datasetFetch('/api/sources')).json();
    if (!captureContextMatches(captured)) return;
    loadMonitors(Array.isArray(data) ? data : data.sources, captured.monitor);
  } finally { if (refresh) refresh.disabled=false; }
}

function loadDatabase(entries) {
  if (entries) dbEntries = entries;
  // Clone and reverse so we add oldest first, newest last (for Map recency)
  (window.CollectorBackgroundLists ? [] : [...dbEntries].reverse()).forEach(e => {
    if (e.label && e.label.trim()) {
      const l = e.label.trim();
      if (e.id.includes("name")) usernamePool.add(l);
    }
  });
  renderDatabase();
  updateStepperButtons();
  renderDatasetNavigator();
}

let saveTimeout = null;
async function saveSessionProgress(immediate = false) {
  if (isRecovering) return;
  snapshotReviewClock();
  const savedDataset = activeDatasetId;
  const activeKeys=new Set(pool.map(sampleKey));
  const boundedAwards=queueMode ? Object.fromEntries(Object.entries(reviewAwards).filter(([key])=>activeKeys.has(key))) : reviewAwards;
  const checkpointPool=queueMode ? pool.slice(0,REVIEW_BATCH_SIZE).map(({base64_image,prediction,...item})=>item) : pool;
  const savedBody = JSON.stringify({...(queueMode ? {queue_mode:'paged',...(isContinuousReview()?{checkpoint_sequence:++streamCheckpointSequence}:{}),review_batch:reviewBatch,queueCompletedStats,queueLastCommitReceipt,queueCompletionRecorded,queueCompletedResult} : {}),frames:queueMode ? [] : frames, pool:checkpointPool, gameCurrencyMap, currentReviewIdx, currentView,
    usernamePool: queueMode ? pool.filter(item=>item.id.endsWith('.name') && item.label).map(item=>item.label) : usernamePool.getItems(), sessionScore, currentCombo, maxCombo, quickLabels,
    autoCompletes, maxReachedIdx, labelingUnlocked, reviewUnlocked, reviewAwards:boundedAwards, rewardVersion:1});
  const doSave = async () => {
    try {
      await datasetFetch("/api/save_session_progress", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        datasetId: savedDataset,
        body: savedBody
        });
    } catch (e) { console.error("Save failed:", e); if (immediate) throw e; }
  };

  if (immediate) {
    if (saveTimeout) clearTimeout(saveTimeout);
    await doSave();
  } else {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = datasetTimeout(doSave, 2000);
  }
}

async function captureFrame() {
  if (manualCaptureBusy || captureWatch?.isActive() || captureWatch?.isBusy() || currentView !== 'collection' || datasetSwitching || isRecovering || document.hidden || !monitorSelect?.value || labelingUnlocked || reviewUnlocked) return;
  manualCaptureBusy = true; updateStepperButtons();
  const presentationGeneration=capturePresentationGeneration;
  const captured = captureContext();
  const m = monitorSelect.value;
  const tempId = Date.now();
  frames.push({id: tempId, loading: true});
  renderFrames();

  try {
    const r = await datasetFetch("/api/capture", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({monitor: m,...(queueMode ? {queue_mode:'paged'} : {})})});
    const d = await r.json();
    if (!captureContextMatches(captured) || currentView !== 'collection') { frames = frames.filter(frame => frame.id !== tempId); renderFrames(); return; }
    if (d.error) {
      const idx = frames.findIndex(f => f.id === tempId);
      if (idx !== -1) frames[idx] = {id: tempId, error: true, loading: false};
      renderFrames();
      datasetTimeout(() => { frames = frames.filter(f => f.id !== tempId); renderFrames(); }, 6000);
      return;
    }
    const idx = frames.findIndex(f => f.id === tempId);
    if (!d.regions?.length) { frames = frames.filter(frame => frame.id !== tempId);renderFrames();return; }
    if(queueMode) {
      frames=frames.filter(frame=>frame.id!==tempId);applyQueueSummary(d.summary);
      const admitted=d.regions.map(item=>({...item,source:item.source || d.source,game_id:item.game_id || d.game_id,frame_id:item.frame_id || d.id})).sort((a,b)=>b.queue_id-a.queue_id);
      collectionCursor=null;collectionPrevious=[];
      collectionItems=[...admitted,...collectionItems.filter(item=>!admitted.some(added=>sampleKey(added)===sampleKey(item)))].slice(0,COLLECTION_PAGE_SIZE);
      const stop=document.getElementById('watch-stop');stop.classList.remove('hidden');stop.disabled=false;
      await showCaptureAdmission({...d,id:d.id || tempId},admitted,()=>presentationGeneration===capturePresentationGeneration && captureContextMatches(captured) && currentView==='collection' && !document.hidden);
      if(captureContextMatches(captured)) await loadCollectionPage();
      return;
    }
    const frame = {...d,id:tempId,thumb:d.thumbnail,loading:false};
    if (idx !== -1) frames[idx] = frame;
    const stop = document.getElementById('watch-stop');stop.classList.remove('hidden');stop.disabled=false;
    await showCaptureAdmission(frame,frame.regions,() => presentationGeneration === capturePresentationGeneration && captureContextMatches(captured) && currentView === 'collection' && !document.hidden);
    if (captureContextMatches(captured) && currentView === 'collection') renderFrames();
    if (!captureContextMatches(captured)) return;
    if (!document.hidden) showToast("Captured " + d.game_id, "success");
    await saveSessionProgress(true);
    if (captureWatch) renderWatchStatus(captureWatch.getState());
  } catch(e) {
    if (!captureContextMatches(captured)) return;
    const idx = frames.findIndex(f => f.id === tempId);
    if (idx !== -1) frames[idx] = {id: tempId, error: true, loading: false};
    renderFrames();
    datasetTimeout(() => { frames = frames.filter(f => f.id !== tempId); renderFrames(); }, 6000);
  } finally { manualCaptureBusy = false; updateStepperButtons(); }
}

function renderCard(options) {
  const {filename, isEditing, onToggle, originalIdx} = options;
  const div = window.PokerLabList.createCard(options);
  if (options.isError || options.isLoading) return div;
  if (onToggle) {
    const item = options.historyItem || (filename ? dbEntries.find(entry => entry.filename === filename) : pool[originalIdx]);
    if (item) {
      const details = document.createElement('details');
      details.className = 'card-history';
      const summary = document.createElement('summary'); summary.textContent = 'Review history';
      const historyBody = document.createElement('div');
      details.append(summary, historyBody);
      details.ontoggle = async () => {
        if (!details.open) {if(window.CollectorBackgroundLists) window.CollectorBackgroundLists.clear(historyBody);return;}
        historyBody.textContent = 'Loading history…';
        if(window.CollectorBackgroundLists) {renderPagedHistory(historyBody,item);return;}
        try {
          const query = new URLSearchParams({sample_key:sampleKey(item), filename:item.filename || ''});
          const data = await (await datasetFetch(`/api/label_history?${query}`)).json();
          renderHistory(historyBody, data);
        } catch (error) { historyBody.textContent = `History unavailable: ${error.message}`; }
      };
      div.appendChild(details);
    }
  }
  if (isEditing && filename) div.appendChild(createDbSuggestionPanel(filename));
  window.CollectorSharedUi?.enhance(div);
  return div;
}
function collectionCropKey(item) { return item.queue_id ? `queue:${item.queue_id}` : `${item.id}:${item.phash || sampleKey(item)}`; }
function collectionCrops() {
  if(queueMode) return collectionItems.slice(0,COLLECTION_PAGE_SIZE).map(item=>{
    const reviewed=pool.find(candidate=>sampleKey(candidate)===sampleKey(item));
    return reviewed ? {...item,...reviewed} : item;
  });
  const seen = new Set(), crops = [];
  for (const frame of [...frames].reverse()) {
    for (const region of [...(frame.regions || [])].reverse()) {
      const item = {...region,source:frame.source,game_id:frame.game_id,frame_id:frame.id,watch:!!frame.watch};
      const key = collectionCropKey(item); if (seen.has(key)) continue;
      seen.add(key);
      const reviewed = pool.find(candidate => collectionCropKey(candidate) === key);
      crops.push(reviewed ? {...item,...reviewed} : item);
    }
  }
  for (const item of [...pool].reverse()) {
    const key = collectionCropKey(item); if (!seen.has(key)) { seen.add(key); crops.push(item); }
  }
  return crops;
}
function collectionAnimationTargets(regions) {
  return regions.map(item => ({sampleKey:sampleKey(item),element:[...(frameListEl.querySelectorAll?.('[data-sample-key]') || frameListEl.children)].find(card => card.getAttribute('data-sample-key') === sampleKey(item))})).filter(target => target.element);
}
async function showCaptureAdmission(frame, regions, isCurrent) {
  if (!isCurrent()) return;
  let prepared = false;
  const prepareTargets = () => {
    if (!isCurrent()) return [];
    if(!queueMode || !window.CollectorBackgroundLists) {renderFrames();prepared=true;return collectionAnimationTargets(regions);}
    return (async()=>{
      await window.CollectorBackgroundLists.invalidate("/api/queue",activeDatasetId);
      renderFrames();prepared=true;
      const deadline=Date.now()+1200;
      while(isCurrent() && Date.now()<deadline && collectionAnimationTargets(regions).length===0) await new Promise(resolve=>setTimeout(resolve,30));
      return isCurrent() ? collectionAnimationTargets(regions) : [];
    })();
  };
  try {
    if (document.hidden || !regions.length || !window.CollectorCaptureAnimation?.present) { await prepareTargets();return; }
    await window.CollectorCaptureAnimation.present({frame:{...frame,image_url:scopedImage(`/api/cap_image/${encodeURIComponent(frame.source)}`)},regions,targets:[],prepareTargets,isCurrent});
  } catch(error) { console.warn('Capture preview unavailable',error); }
  finally { if (!prepared && isCurrent()) renderFrames(); }
}

function renderFrames() {
  window.CollectorScroll?.remember('collection', activeDatasetId, {cursor:collectionCursor,previous:collectionPrevious});
  const existing = new Map([...(frameListEl.querySelectorAll?.('.collection-crop-card') || frameListEl.children)].map(card => [card.getAttribute('data-id'),card]));
  const positions = new Map([...existing].map(([key,card]) => [key,card.getBoundingClientRect?.()]));
  const finishedCount = queueMode ? queueSummary?.captures || 0 : frames.filter(frame => !frame.loading && !frame.error && frame.regions?.length).length;
  document.getElementById('count-frames-pill').textContent = `${finishedCount} capture${finishedCount === 1 ? '' : 's'}`;
  const crops = collectionCrops();
  const pending = frames.filter(frame => frame.loading || frame.error);
  document.getElementById('collection-placeholder').classList.toggle('hidden',crops.length > 0 || pending.length > 0);
  frameListEl.classList.toggle('hidden',!crops.length && !pending.length);
  const createCollectionCard = item => {
    if(item.__pending) return renderCard({imageSrc:"",id:"Capture",isLoading:item.loading,isError:item.error,dataId:String(item.id)});
    const key = collectionCropKey(item);
    const hasCapture = !!item.source && (queueMode || frames.some(frame => frame.source === item.source));
    const signature = JSON.stringify([item.label,!!item.reviewed,!!item.discarded,item.game_id,item.source,!!item.watch,sampleKey(item),hasCapture]);
    const old = existing.get(key);
    if (!window.CollectorBackgroundLists && old?.getAttribute('data-render-state') === signature) return old;
    const card = renderCard({imageSrc:cropImage(item),label:item.label,id:item.id,isUnreviewed:!item.reviewed && !item.discarded,isBlank:item.reviewed && item.label === '',isIgnored:item.discarded,dataId:key});
    card.classList.add('collection-crop-card');
    card.setAttribute('data-sample-key',sampleKey(item));card.setAttribute('data-region-id',item.id);card.setAttribute('data-render-state',signature);
    const meta = card.querySelector('.card-meta');
    const region = meta.querySelector('span');region.className='card-region';region.title=item.id;
    meta.querySelector('div')?.remove();
    const state = item.discarded ? 'skipped' : item.reviewed ? item.label === '' ? 'blank' : 'reviewed' : 'pending';
    const statusLabel = {skipped:'Skipped',blank:'Reviewed blank',reviewed:'Reviewed',pending:'Needs review'}[state];
    card.setAttribute('aria-label',`${item.id} · ${statusLabel}`);
    const menu = document.createElement('div');menu.className='collection-card-menu';menu.dataset.regionId=item.id;
    menu.dataset.menuLabel=item.game_id ? `Game ${item.game_id}` : 'Recovered crop';
    const epoch=datasetEpoch,datasetId=activeDatasetId;
    const current=() => epoch===datasetEpoch && datasetId===activeDatasetId && !datasetSwitching;
    if (item.source) {
      const link = document.createElement('a');link.textContent='View capture';link.href=scopedImage(`/api/cap_image/${encodeURIComponent(item.source)}`);link.target='_blank';link.rel='noopener';menu.appendChild(link);
    }
    const removeCrop = document.createElement('button');removeCrop.type='button';removeCrop.className='btn-ghost crop-remove-button';
    removeCrop.title='Remove crop';removeCrop.setAttribute('aria-label','Remove crop');
    removeCrop.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>';
    removeCrop.onclick=() => {if(current()) return removeCollectionCrop(item);};meta.appendChild(removeCrop);
    if (hasCapture) {
      const removeCapture = document.createElement('button');removeCapture.type='button';removeCapture.className='btn-danger';removeCapture.textContent='Remove capture';
      removeCapture.onclick=() => {if(!current()) return;if(queueMode) return discardQueue({frame_ids:[item.frame_id || item.watch_frame_id]});const index=frames.findIndex(frame => frame.source === item.source);if(index>=0) return removeFrame(index);};menu.appendChild(removeCapture);
    }
    meta.appendChild(menu);window.CollectorSharedUi?.enhance(card);return card;
  };
  if(queueMode && window.CollectorBackgroundLists) {
    frameListEl.classList.add("instant-list-host");
    frameListEl.classList.remove("hidden");
    const epoch=datasetEpoch, datasetId=activeDatasetId;
    window.CollectorBackgroundLists.render(frameListEl, {path:"/api/queue",datasetId,query:{order:"newest"},fillViewport:true,prefix:pending.map(frame=>({...frame,id:String(frame.id),__pending:true})),key:item=>item.__pending ? `pending:${item.id}` : collectionCropKey(item),card:createCollectionCard,changed:(items,meta,loading,error)=>{
      if(epoch!==datasetEpoch || datasetId!==activeDatasetId) return;
      collectionItems=items; if(meta?.summary) applyQueueSummary(meta.summary);
      document.getElementById("collection-placeholder").classList.toggle("hidden",items.length>0 || pending.length>0 || loading || error);
    }});
    document.getElementById("collection-pagination")?.classList.add("hidden");
    updateStatusBar();updateQueueControls();updateStepperButtons();return;
  }
  const cards = crops.map(createCollectionCard);
  for (const frame of pending) cards.unshift(renderCard({imageSrc:'',id:'Capture',isLoading:frame.loading,isError:frame.error,dataId:String(frame.id)}));
  const retained = new Set(cards);
  for (const old of [...frameListEl.children]) if (!retained.has(old)) { window.CollectorSharedUi?.disposeMenus?.(old);old.remove(); }
  cards.forEach((card,index) => { if (frameListEl.children[index] !== card) frameListEl.insertBefore(card,frameListEl.children[index] || null); });
  if (!document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    for (const card of cards) {
      const before = positions.get(card.getAttribute('data-id'));
      const after = card.getBoundingClientRect?.();
      if (before && after && card.animate) {
        const x = before.left - after.left, y = before.top - after.top;
        if (x || y) card.animate([{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,0)'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
      }
    }
  }
  updateStatusBar();updateQueueControls();updateStepperButtons();
}
async function removeCollectionCrop(item) {
  if(queueMode) {await discardQueue({sample_keys:[sampleKey(item)]});return;}
  if (item.watch) {
    try { await datasetFetch('/api/watch/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_keys:[sampleKey(item)]})}); }
    catch(error) { showToast(error.message,'error');return; }
  }
  const key = collectionCropKey(item);
  for (const frame of frames) frame.regions = (frame.regions || []).filter(region => collectionCropKey(region) !== key);
  frames = frames.filter(frame => frame.loading || frame.error || frame.regions?.length);
  pool = pool.filter(candidate => collectionCropKey(candidate) !== key);
  prunePoolsForItem(item);currentReviewIdx=Math.min(currentReviewIdx,Math.max(0,pool.length-1));
  renderFrames();await saveSessionProgress(true);
}

function updateStatusBar() {
  const t = queueMode ? queueSummary?.total || 0 : collectionCrops().length;
  const el = document.getElementById("count-regions-pill");
  if (el) {
    const newText = t + " crop" + (t !== 1 ? 's' : '');
    if (el.textContent !== newText) {
      el.textContent = newText;
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  }
}

async function removeFrame(idx) {
  const frame = frames[idx]; if (!frame) return;
  if (frame.watch) {
    try { await datasetFetch('/api/watch/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frame_ids:[frame.id]})}); }
    catch (error) { showToast(error.message,'error'); return; }
  }
  frames.splice(idx,1);
  if (frame.source) pool = pool.filter(item => item.source !== frame.source);
  renderFrames(); saveSessionProgress();
}

function processPool() {
  if(queueMode) {if(pool.length) renderReview();return;}
  // A recovered/imported session can have crops without retained capture frames.
  // Preserve those reviewed crops rather than rebuilding an empty pool.
  if (!frames.length && pool.length) { renderReview(); return; }
  showLoading(true, "Processing Regions...");
  const raw = []; frames.forEach(f => (f.regions || []).forEach(r => raw.push({...r, game_id: f.game_id, source: f.source, watch:!!f.watch})));
  const np = [...pool];
  raw.forEach(item => {
    if (!np.find(u => u.id === item.id && u.phash === item.phash)) {
      const e = pool.find(p => p.id === item.id && p.phash === item.phash);
      np.push(e || {...item, discarded: false});
    }
  });
  pool = np;

  // Clear currency map on pool refresh to avoid stale markers
  gameCurrencyMap = {};

  if (currentReviewIdx >= pool.length) currentReviewIdx = Math.max(0, pool.length - 1);
  renderReview();
  showLoading(false);
}

function getCurrencyForGame(gameId) {
  if (!gameId) return null;
  for (let i = 0; i < pool.length; i++) {
    // Only use items that are NOT the current one and have a label and are NOT discarded
    if (pool[i].game_id === gameId && pool[i].label && !pool[i].discarded) {
      const curMatch = pool[i].label.match(/^[GS] /) || pool[i].label.match(/^Pot: [GS] /);
      if (curMatch) {
        const c = curMatch[0].includes("Pot: ") ? curMatch[0].split(" ")[1] : curMatch[0].trim();
        gameCurrencyMap[gameId] = c;
        return c;
      }
    }
  }
  return gameCurrencyMap[gameId] || null;
}

function renderReview() {
  const hud = document.getElementById("labeling-hud");
  if (!pool.length) { setView('collection'); return; }
  hud.classList.remove("hidden");

  if (currentReviewIdx === 0) highscoreAdded = false;

  const item = pool[currentReviewIdx];
  if (reviewClock.key && reviewClock.key !== sampleKey(item)) leaveReviewClock();
  const c = getCurrencyForGame(item.game_id);

  const statsCard = document.getElementById("labeling-stats-card");
  if (statsCard) statsCard.classList.add("hidden");
  document.getElementById("labeling-hud").classList.remove("hidden");
  const hadClockForItem = reviewClock.key === sampleKey(item);
  startReviewClock(item);
  usedAutoComplete = false;
  updateScoreDisplay();

  document.getElementById("review-idx").textContent = (isContinuousReview() ? reviewBatch.legacy_offset || 0 : 0)+currentReviewIdx + 1;
  document.getElementById("count-regions").textContent = isContinuousReview() ? reviewBatch.total_at_start : pool.length;

  if (currentReviewIdx > maxReachedIdx) maxReachedIdx = currentReviewIdx;

  const progress = (((isContinuousReview() ? reviewBatch.legacy_offset || 0 : 0)+currentReviewIdx + 1) / (isContinuousReview() ? reviewBatch.total_at_start : pool.length)) * 100;
  const ghostProgress = (((isContinuousReview() ? reviewBatch.legacy_offset || 0 : 0)+maxReachedIdx + 1) / (isContinuousReview() ? reviewBatch.total_at_start : pool.length)) * 100;

  document.getElementById("progress-bar").style.width = progress + "%";
  document.getElementById("progress-bar-ghost").style.width = ghostProgress + "%";

  document.getElementById("region-meta").textContent = item.id + " [" + item.game_id + "] " + (item.discarded ? '(IGNORED)' : '');

  beginReviewVisual(item);

  let initialVal = "";
  if (!item.label) {
    if (item.id.includes("pot") && !item.id.includes("split")) {
      initialVal = c ? `Pot: ${c} ` : "Pot: ";
    }
    else if (item.id.includes("split") || item.id.includes("bank") || item.id.includes("bet")) {
      initialVal = c ? c + " " : "";
    }
    else initialVal = "";
  } else initialVal = item.label;

  // Restore draft if index matches (survives hot-reload)
  const draftStr = datasetStorage.getItem(draftKey());
  if (draftStr) {
    try {
      const draft = JSON.parse(draftStr);
      if (draft.sample_key === sampleKey(item) || (!draft.sample_key && (draft.idx === currentReviewIdx || queueMode && draft.idx === (reviewBatch?.legacy_offset || 0) + currentReviewIdx))) {
        initialVal = draft.value;
        if (draft.reward && !item.review_reward) restoreReviewAward(item, draft.reward);
        if (draft.reviewed && typeof draft.reviewed_label === 'string') { item.reviewed = true; item.label = draft.reviewed_label; }
        if (draft.clock && !hadClockForItem) startReviewClock(item, draft.clock);
        if (draft.isPaused) {
          isPaused = true;
          pauseStartTime = draft.pauseStartTime || Date.now();
          document.getElementById("pause-overlay").classList.remove("hidden");
          labelInput.disabled = true;
        }
      }
    } catch(e) {}
  }
  labelInput.value = initialVal;

  // Preserve draft and frozen read-time across reloads.
  persistReviewDraft();

  lastValue = labelInput.value;
  actionHistory = [];

  labelInput.focus({preventScroll:true}); labelInput.setSelectionRange(labelInput.value.length, labelInput.value.length);
  validateInput(); updateAutocomplete(); updateScoreDisplay();
  requestModelSuggestion(item);
  if(isContinuousReview()) void prefetchReview().catch(error=>showToast(error.message,'error'));
  document.getElementById("btn-restore").classList.toggle("hidden", !item.discarded);
  document.getElementById("hint-prev").style.display = currentReviewIdx === 0 ? "none" : "inline";

  const isLabeled = (item.label && item.label.trim() !== "") || item.reviewed || item.discarded;
  const canGoNext = currentReviewIdx < pool.length - 1 && (isLabeled || currentReviewIdx < maxReachedIdx);
  document.getElementById("hint-next").style.display = canGoNext ? "inline" : "none";
}

function restoreCurrent() { if (pool.length) pool[currentReviewIdx].discarded = false; renderReview(); }

let lastNamesQuery="";
function updateAutocomplete() {
  const item = pool[currentReviewIdx]; if (!item) return;
  const schema = SchemaRegistry.getSchema(item.id);
  const typed = labelInput.value;
  if(typeof window !== "undefined" && window.CollectorBackgroundLists && schema === Schemas.NAME && typed && typed !== lastNamesQuery) { lastNamesQuery=typed;void refreshNames(typed); }

  const result = schema.getSuggestion(typed, item);

  if (result) {
    currentSuggestion = result.suggestion;
    labelInput.placeholder = "";

    let rem = "";
    if (result.isFuzzy) {
      rem = ` > ${currentSuggestion}`;
    } else if (result.type === 'append' && currentSuggestion.startsWith(typed)) {
      rem = currentSuggestion.slice(typed.length);
    } else {
      const valLower = typed.toLowerCase();
      const sugLower = currentSuggestion.toLowerCase();
      if (sugLower.startsWith(valLower)) {
        rem = currentSuggestion.slice(typed.length);
      } else if ([Schemas.MONEY, Schemas.BANK, Schemas.POT, Schemas.SPLIT_POT].includes(schema)) {
        let body = typed;
        const m = typed.match(/^(?:Pot:\s*)?(?:[GS]\s*)?/i);
        if (m) body = typed.slice(m[0].length);
        if (body && sugLower.startsWith(body.toLowerCase())) {
           rem = currentSuggestion.slice(body.length);
        }
      }
    }

    const typedSpan = document.createElement('span');
    typedSpan.style.cssText = 'display:inline-block;position:relative;color:transparent;white-space:pre;vertical-align:middle';
    typedSpan.textContent = '\u200b' + typed;
    const suggestionSpan = document.createElement('span');
    suggestionSpan.className = 'suggestion-part';
    suggestionSpan.style.cssText = 'position:absolute;left:100%;top:50%;transform:translateY(-50%);white-space:pre;text-align:left';
    suggestionSpan.textContent = rem;
    const keySpan = document.createElement('span');
    keySpan.className = 'kbd';
    keySpan.style.cssText = 'font-size:9px;margin-left:8px;opacity:0.6;vertical-align:middle;position:relative;top:-1px';
    keySpan.textContent = 'TAB';
    suggestionSpan.append(keySpan);
    typedSpan.append(suggestionSpan);
    ghostText.replaceChildren(typedSpan);
  } else {
    currentSuggestion = "";
    ghostText.innerHTML = "";
    labelInput.placeholder = "Type here...";
  }
}

function updateBulkDatalist(view) {
  const listId = view === 'review' ? 'review-bulk-list' : 'db-bulk-list';
  const listEl = document.getElementById(listId);
  if (!listEl) return;

  const selectedItems = view === 'review'
    ? typeof isFullSessionReview==='function' && isFullSessionReview() ? fullReviewSelection() : Array.from(selectedPoolIndices).map(idx => pool[idx])
    : Array.from(selectedFiles).map(fn => dbEntries.find(e => e.filename === fn)).filter(Boolean);

  const commonSchemaName = getCommonRegionType(selectedItems);
  if (!commonSchemaName) {
    listEl.innerHTML = "";
    return;
  }

  const schema = SchemaRegistry.getSchema(selectedItems[0].id);
  let suggestions = [];
  if (schema === Schemas.STATUS) suggestions = schema.allowed;
  else if (schema === Schemas.NAME) suggestions = [...new Set([...usernamePool.getItems(),...nativeNameSuggestions])];
  else if (schema === Schemas.CARD) suggestions = schema.ranks;
  else if (schema === Schemas.BANK || schema === Schemas.MONEY) suggestions = ["G ", "S "];

  listEl.innerHTML = suggestions.map(s => `<option value="${s}">`).join("");
}

function updateEditDatalist(item) {
  const listEl = document.getElementById('edit-datalist');
  if (!listEl || !item) return;

  const schema = SchemaRegistry.getSchema(item.id);
  let suggestions = [];
  if (schema === Schemas.STATUS) suggestions = schema.allowed;
  else if (schema === Schemas.NAME) suggestions = [...new Set([...usernamePool.getItems(),...nativeNameSuggestions])];
  else if (schema === Schemas.CARD) suggestions = schema.ranks;
  else if (schema === Schemas.BANK || schema === Schemas.MONEY) suggestions = ["G ", "S "];

  listEl.innerHTML = suggestions.map(s => `<option value="${s}">`).join("");
}

function getCommonRegionType(items) {
  if (items.length === 0) return null;
  const types = new Set(items.map(item => {
    const s = SchemaRegistry.getSchema(item.id);
    if (s === Schemas.NAME) return "name";
    if (s === Schemas.STATUS) return "status";
    if (s === Schemas.CARD) return "card";
    if (s === Schemas.BANK || s === Schemas.MONEY) return "money";
    if (s === Schemas.POT || s === Schemas.SPLIT_POT) return "pot";
    return "field";
  }));
  return types.size === 1 ? Array.from(types)[0] : null;
}

function validateInput() {
  const item = pool[currentReviewIdx]; if (!item) return;
  const typed = labelInput.value;
  const schema = SchemaRegistry.getSchema(item.id);

  if (typed === "") {
    inputGroup.className = "label-input-group um-game-input-group";
    currentValidationError = null;
    return;
  }

  persistReviewDraft();

  const { isValid, errorMsg } = schema.validate(typed, item);
  const isPartial = schema.isPartial(typed, item);

  const v = isValid || isPartial;
  inputGroup.className = v ? "label-input-group um-game-input-group" : "label-input-group um-game-input-group invalid";
  currentValidationError = !v ? errorMsg : null;
}function syncPoolsWithLabelChange(oldLabel, newLabel, category) {
  if (category !== "name") return;
  const store = usernamePool;
  if (oldLabel && oldLabel !== newLabel) {
    // Discovery Penalty: If removing the ONLY instance of a username
    if (store.getCount(oldLabel) === 1) {
      sessionScore = Math.max(0, sessionScore - 50);
      showFloatingScore("NAME CORRECTION -50", 'correction');
      updateScoreDisplay();
    }
    store.remove(oldLabel);
  }
  if (newLabel && oldLabel !== newLabel) store.add(newLabel);
}

function prunePoolsForItem(item) {
  if (!item.id.includes("name") || !item.label) return;
  const store = usernamePool;
  
  if (store.getCount(item.label) === 1) {
    sessionScore = Math.max(0, sessionScore - 50);
    showFloatingScore("NAME REMOVED -50", 'penalty');
    updateScoreDisplay();
  }
  store.remove(item.label);
}

function getComboMultiplier(combo) {
  if (combo >= 20) return 5;
  if (combo >= 10) return 3;
  if (combo >= 5) return 2;
  return 1;
}

// Preserve the collector game rules; shared helpers validate receipts and own the pause-aware read clock.
function reviewHelpers() {
  const helpers = window.CollectorSharedUi?.reviewGamification;
  if (!helpers) throw new Error('Shared review helpers are unavailable. Reload the collector.');
  return helpers;
}
function currentAwardLedger() {
  const helpers = reviewHelpers(), awardedSampleIds = Object.keys(reviewAwards);
  try { return helpers.restoreAwardLedger({points:sessionScore, streak:currentCombo, awardedSampleIds}); }
  catch { const recovered = helpers.createAwardLedger({awardedSampleIds}); applyAwardLedger(recovered); return recovered; }
}
function validReviewReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || !Object.hasOwn(receipt, 'points')) return null;
  try { reviewHelpers().restoreAwardLedger({points:receipt.points, streak:0, awardedSampleIds:[]}); return receipt; }
  catch { return null; }
}
function restoreReviewSessionRewards(saved) {
  const receipts = saved.reviewAwards && typeof saved.reviewAwards === 'object' && !Array.isArray(saved.reviewAwards) ? saved.reviewAwards : {};
  reviewAwards = Object.create(null);
  for (const [key, receipt] of Object.entries(receipts)) if (key && validReviewReceipt(receipt)) reviewAwards[key] = receipt;
  for (const item of pool) {
    const receipt = validReviewReceipt(item.review_reward);
    if (receipt) reviewAwards[sampleKey(item)] = receipt;
    else {
      delete item.review_reward;
      if (item.reviewed) reviewAwards[sampleKey(item)] = {points:0, action:'save', label:item.label, previouslyReviewed:true};
    }
  }
  maxCombo = Number.isSafeInteger(saved.maxCombo) && saved.maxCombo >= 0 ? saved.maxCombo : 0;
  const helpers = reviewHelpers(), awardedSampleIds = Object.keys(reviewAwards);
  try { applyAwardLedger(helpers.restoreAwardLedger({points:saved.sessionScore ?? 0, streak:saved.currentCombo ?? 0, awardedSampleIds})); }
  catch { applyAwardLedger(helpers.createAwardLedger({awardedSampleIds})); }
}
function applyAwardLedger(ledger) {
  sessionScore = ledger.points; currentCombo = ledger.streak; maxCombo = Math.max(maxCombo, ledger.streak);
}
function restoreReviewAward(item, receipt) {
  if (!validReviewReceipt(receipt)) return;
  const helpers = reviewHelpers(), sampleId = sampleKey(item);
  const result = receipt.previouslyReviewed
    ? helpers.awardSample(currentAwardLedger(), {sampleId, action:'save', label:receipt.label || '', previouslyReviewed:true})
    : helpers.restoreSampleAward(currentAwardLedger(), {sampleId, points:receipt.points});
  reviewAwards[sampleId] = receipt; applyAwardLedger(result.ledger);
  item.review_reward = receipt;
}
function awardReviewedSample(item, label, action, prediction, wasReviewed = false, previousState = null) {
  const key = sampleKey(item), priorReceipt = reviewAwards[key] || item.review_reward;
  const prior = previousState || {label:item.label, reviewed:wasReviewed, discarded:!!item.discarded};
  // Receipts also cover rebuilt/recovered pool objects and explicit blank truth.
  if (priorReceipt) {
    prior.reviewed = true;
    if (!prior.label) prior.label = priorReceipt.label ?? '';
  }
  const before = sessionScore;
  const previousAutoComplete = usedAutoComplete;
  if (action === 'accept' || action === 'accepted') usedAutoComplete = true;
  processGamification(true, false, label, item, prior, action);
  usedAutoComplete = previousAutoComplete;
  const receipt = priorReceipt && prior.label === label ? priorReceipt : {points:Math.max(0, sessionScore-before), action, label, previouslyReviewed:!!prior.reviewed};
  // Keep the immutable shared ledger's identifier validation and idempotence;
  // do not replace the original score/combo with the generic review policy.
  reviewHelpers().restoreSampleAward(currentAwardLedger(), {sampleId:key, points:receipt.points});
  reviewAwards[key] = receipt; item.review_reward = receipt;
  return sessionScore-before;
}

function processGamification(isValid, isDiscard, newLabel = null, item = pool[currentReviewIdx], previousState = null, reviewAction = null) {
  if (!item) return;
  const elapsed = reviewElapsed();
  const previous = previousState || item;
  
  // Prevent exploit: No points for re-saving the same label or previously labeled items
  const isAlreadyLabeled = !!previous.reviewed || !!(previous.label && previous.label.trim() !== "");
  const labelChanged = newLabel !== null && previous.label !== newLabel;
  const isAlreadyDiscarded = previous.discarded;
  
  // Do nothing if we are just re-saving the exact same state
  if (isValid && !isDiscard && isAlreadyLabeled && !labelChanged) {
      return; 
  }
  if (isDiscard && isAlreadyDiscarded && !labelChanged) {
      return;
  }

  // Correction Penalty: If we are changing an already labeled item
  if (isValid && isAlreadyLabeled && labelChanged) {
    const penalty = 100;
    sessionScore = Math.max(0, sessionScore - penalty);
    showFloatingScore(`CORRECTION -${penalty}`, 'correction');
    currentCombo = 0; // Reset combo on correction
    updateScoreDisplay();
    // Proceed to award small points for the new typing (optional, but let's keep it consistent)
  }

  item.labelTime = elapsed;
  
  let pts = 0;
  let ptsType = null;
  const mult = getComboMultiplier(currentCombo);
  
  if (isDiscard) {
    if (elapsed < 5000) { 
      // Safe from combo reset up to 5000ms to match the UI timer
      if (elapsed < 1000) {
        pts = 20 * mult;
        ptsType = 'discard';
      }
      currentCombo++; 
    }
    else currentCombo = 0;
  } else if (isValid) {
    if (elapsed < 5000) {
      currentCombo++;
      if (usedAutoComplete) { 
        pts = 60 * mult; autoCompletes++; 
        ptsType = reviewAction === 'accept' || reviewAction === 'accepted' ? 'model_accept' : 'auto';
      }
      else { 
        pts = 100 * mult; quickLabels++; 
        ptsType = 'quick';
      }
    } else currentCombo = 0;

    // Username Discovery Bonus (+50 flat)
    if (newLabel && item.id.includes("name") && !usernamePool.has(newLabel) && !nativeNameSuggestions.includes(newLabel)) {
      if (ptsType === 'model_accept' && pts > 0) showFloatingScore(pts, ptsType);
      pts += 50;
      showFloatingScore("NEW NAME +50", 'name_bonus');
      // If we showed the bonus msg, we don't want the numeric pts popup to trigger later
      // and create a duplicate visual.
      sessionScore += pts;
      updateScoreDisplay();
      return;
    }
  } else {
    currentCombo = 0;
  }
  if (currentCombo > maxCombo) maxCombo = currentCombo;
  sessionScore += pts;
  updateScoreDisplay();
  if (pts > 0) showFloatingScore(pts, ptsType);
}


function resetReviewClock() { reviewClock = {key:null, state:null}; }
function reviewElapsed() { return reviewClock.state ? reviewHelpers().readClockElapsedMs(reviewClock.state, Date.now()) : 0; }
function reviewClockSnapshot() { return reviewClock.state ? reviewHelpers().snapshotReadClock(reviewClock.state, Date.now()) : null; }
function reviewClockReason() {
  const reasons = reviewClock.state?.pauseReasons || [];
  return reasons.includes('editing') ? 'editing' : reasons.includes('loading') ? 'loading' : reasons.includes('paused') ? 'paused' : reasons.includes('idle') ? 'idle' : '';
}
function snapshotReviewClock() {
  const item = pool.find(candidate => sampleKey(candidate) === reviewClock.key);
  if (item) item.review_clock = reviewClockSnapshot();
}
function persistedClockSnapshot(saved) {
  if (!saved || saved.elapsedMs !== undefined) return saved;
  // Read sessions saved by the earlier collector without owning any clock arithmetic.
  return {elapsedMs:saved.elapsed_ms, pauseReasons:saved.frozen ? [saved.reason === 'pause' ? 'paused' : saved.reason] : []};
}
function startReviewClock(item, saved) {
  if (saved === undefined) saved = reviewClock.key === sampleKey(item) ? reviewClockSnapshot() : item.review_clock;
  const helpers = reviewHelpers();
  let state;
  try { state = saved ? helpers.restoreReadClock(persistedClockSnapshot(saved), Date.now()) : helpers.createReadClock(Date.now()); }
  catch { state = helpers.createReadClock(Date.now()); }
  reviewClock = {key:sampleKey(item), state};
}
function freezeReviewClock(reason) {
  const item = pool[currentReviewIdx];
  if (!item) return;
  if (reviewClock.key !== sampleKey(item)) startReviewClock(item);
  reviewClock.state = reviewHelpers().pauseReadClock(reviewClock.state, reason === 'pause' ? 'paused' : reason, Date.now());
  snapshotReviewClock(); persistReviewDraft(); checkComboExpiration();
}
function resumeReviewClock(reason) {
  if (!reviewClock.state) return;
  reviewClock.state = reviewHelpers().resumeReadClock(reviewClock.state, reason === 'pause' ? 'paused' : reason, Date.now());
  snapshotReviewClock(); persistReviewDraft();
}
function releaseReviewClock(item) {
  if (!reviewClock.state || reviewClock.key !== sampleKey(item)) return;
  const helpers = reviewHelpers();
  for (const reason of reviewClock.state.pauseReasons) reviewClock.state = helpers.resumeReadClock(reviewClock.state, reason, Date.now());
  item.review_clock = reviewClockSnapshot();
}
function finishReviewClock(item) {
  if (reviewClock.key !== sampleKey(item)) return;
  releaseReviewClock(item); resetReviewClock();
}
function leaveReviewClock() {
  const item = pool.find(candidate => sampleKey(candidate) === reviewClock.key);
  if (item) releaseReviewClock(item);
  if (item) datasetStorage.setItem(`draft:${sampleKey(item)}`, JSON.stringify({idx:pool.indexOf(item),value:labelInput?.value ?? '',clock:item.review_clock,isPaused:false}));
  isPaused = false;
  if (labelInput) labelInput.disabled = false;
  document.getElementById('pause-overlay')?.classList.add('hidden');
  resetReviewClock();
}
function persistReviewDraft() {
  if (!pool[currentReviewIdx]) return;
  snapshotReviewClock();
  datasetStorage.setItem(draftKey(), JSON.stringify({sample_key:sampleKey(pool[currentReviewIdx]),idx:currentReviewIdx, value:labelInput?.value ?? '', clock:reviewClockSnapshot(), reward:pool[currentReviewIdx].review_reward || null, reviewed:!!pool[currentReviewIdx].reviewed, reviewed_label:pool[currentReviewIdx].reviewed ? pool[currentReviewIdx].label : undefined, isPaused, pauseStartTime}));
}
function togglePause() {
  isPaused = !isPaused;
  document.getElementById('pause-overlay').classList.toggle('hidden', !isPaused);
  labelInput.disabled = isPaused;
  if (isPaused) { freezeReviewClock('pause'); labelInput.blur(); }
  else { resumeReviewClock('pause'); labelInput.focus({preventScroll:true}); }
  persistReviewDraft();
}
function updateScoreDisplay() {
  const scoreEl = document.getElementById("score-display");
  const comboEl = document.getElementById("combo-display");
  const multiplierEl = document.getElementById("combo-multiplier");
  const badgeEl = document.getElementById("combo-badge");
  const inputEl = document.getElementById("label-input");

  // HUD-only multiplier logic (doesn't affect actual state until save)
  const elapsed = reviewElapsed();
  const isExpired = currentView === 'labeling' && elapsed > 5000;
  const displayCombo = isExpired ? 0 : currentCombo;

  const multiplier = getComboMultiplier(displayCombo);
  const mColors = { 1: "var(--game-combo-base)", 2: "var(--game-combo-2)", 3: "var(--game-combo-3)", 5: "var(--game-combo-5)" };
  const color = mColors[multiplier] || "var(--game-combo-base)";

  if (scoreEl) {
    if (currentValidationError) {
      scoreEl.textContent = currentValidationError;
      scoreEl.style.color = "var(--danger)";
      scoreEl.style.textShadow = "0 0 10px color-mix(in oklab,var(--destructive) 50%,transparent)";
    } else {
      scoreEl.textContent = `SCORE: ${sessionScore.toLocaleString()}`;
      scoreEl.style.color = displayCombo >= 1 ? color : "var(--muted-foreground)";
      scoreEl.style.textShadow = displayCombo >= 1 ? `0 0 10px color-mix(in oklab,${color} 53%,transparent)` : "";
    }
  }
  if (comboEl) comboEl.textContent = `Combo: x${multiplier} (${displayCombo})`;
  if (multiplierEl) multiplierEl.textContent = `x${multiplier}`;

  if (badgeEl && inputEl) {
    badgeEl.style.color = color;
    badgeEl.style.borderColor = color;
    badgeEl.style.boxShadow = displayCombo > 0 ? `0 0 15px color-mix(in oklab,${color} 40%,transparent)` : "none";

    // Only jiggle during the warning window (3s - 5s)
    const shouldJiggle = displayCombo > 0 && elapsed > 3000 && elapsed <= 5000;
    badgeEl.classList.toggle("jiggle", shouldJiggle);

    // Manage dynamic classes for arcade HUD effects
    const wrapper = inputEl.closest('.label-input-group');
    if (wrapper) {
      wrapper.classList.remove("combo-x1", "combo-x2", "combo-x3", "combo-x5");
      wrapper.classList.add(`combo-x${multiplier}`);
      wrapper.style.borderColor = "";
      wrapper.style.boxShadow = "";
    }

    // Apply color to input directly
    inputEl.style.setProperty('--combo-color', color);
    inputEl.style.borderColor = displayCombo >= 1 ? color : "";
    inputEl.style.boxShadow = displayCombo >= 1 ? `0 0 20px color-mix(in oklab,${color} 27%,transparent)` : "";
    inputEl.style.color = multiplier >= 2 ? color : "var(--foreground)";
  }
}





async function saveCurrentAndNext() {
  if (!pool.length || reviewSaving || datasetSwitching) return;
  const item = pool[currentReviewIdx];
  const label = labelInput.value.trim();
  const { isValid, errorMsg } = SchemaRegistry.validateReviewed(item.id, label);
  if (label !== '' && !isValid) { inputGroup.classList.add('invalid'); currentCombo = 0; updateScoreDisplay(); showToast(errorMsg || 'Correct the label before saving.', 'error'); return; }
  await persistReview(item, label, 'correct');
}

async function discardCurrentAndNext() {
  if (!pool.length) return;
  processGamification(false, true);

  const item = pool[currentReviewIdx];
  item.discarded = true; item.label = labelInput.value; prunePoolsForItem(item);
  if(isContinuousReview()) {await saveSessionProgress(true);updateStepperButtons();datasetStorage.removeItem(draftKey());await advanceContinuousReview();return;}
  saveSessionProgress(); updateStepperButtons();
  datasetStorage.removeItem(draftKey());
  if (currentReviewIdx === pool.length - 1) showLabelingStats(); else { datasetTimeout(next, 150); }
}

async function deleteCurrentCrop() {
  if (currentView !== 'labeling' || isPaused || reviewSaving || streamAdvancing || queueLoading || datasetSwitching || !pool[currentReviewIdx]) return;
  const item=pool[currentReviewIdx],key=sampleKey(item),epoch=datasetEpoch;
  reviewSaving=true;labelInput.disabled=true;freezeReviewClock('idle');
  try {
    if(isContinuousReview() && currentReviewIdx===pool.length-1 && reviewBatch.next_cursor) await prefetchReview(true);
    const hadNext=currentReviewIdx<pool.length-1;
    if(queueMode) {
      const removed=await discardQueue({sample_keys:[key]});
      if(!removed && pool.some(candidate=>sampleKey(candidate)===key)) return;
    } else await removeCollectionCrop(item);
    if(epoch!==datasetEpoch) return;
    if(pool.some(candidate=>sampleKey(candidate)===key)) return;
    datasetStorage.removeItem(`draft:${key}`);modelRequest++;modelPrediction=null;clearModelTextTransition();
    leaveReviewClock();
    if(isContinuousReview()) {
      trimReviewHistory();
      if(!hadNext) {await finishContinuousReview();return;}
      const query=new URLSearchParams({run_id:reviewBatch.batch_id});
      const stats=await (await datasetFetch('/api/queue/review/stats?'+query)).json();
      streamStats=stats.review_stats || streamStats;
      await preloadReviewImage(pool[currentReviewIdx]);
    }
    if(pool.length && hadNext) {setView('labeling');if(isContinuousReview()) void prefetchReview().catch(error=>showToast(error.message,'error'));}
    else await showLabelingStats();
  } catch(error) {if(epoch===datasetEpoch) showToast(error.message,'error');}
  finally {
    if(epoch===datasetEpoch) {
      reviewSaving=false;labelInput.disabled=isPaused;resumeReviewClock('idle');
      if(modelPrediction) setModelState(document.getElementById('model-state').textContent,modelPrediction);
      updateStepperButtons();
      if(currentView==='labeling' && !isPaused && viewLabelingStats.classList.contains('hidden')) labelInput.focus({preventScroll:true});
    }
  }
}

const handleBulkLabel = async (view) => {
  if(view==='review' && typeof isFullSessionReview==='function' && isFullSessionReview()) return bulkLabelFullSession();
  const inputId = view === 'review' ? 'review-bulk-label-input' : 'db-bulk-label-input';
  const label = document.getElementById(inputId).value.trim();
  if (!label) return;
  if (view === 'review') {
    const count = selectedPoolIndices.size;
    for (const idx of [...selectedPoolIndices]) {
      const item = pool[idx], oldLabel = item.label;
      try { await persistEditedItem(item, label); } catch (error) { showToast(error.message, 'error'); return; }
      item.discarded = false;
      syncPoolsWithLabelChange(oldLabel, label, item.id.includes('name') ? 'name' : null);
    }
    document.getElementById(inputId).value = ""; selectedPoolIndices.clear();
    saveSessionProgress(); updateStepperButtons(); renderSessionReview();
    showToast("Applied label to " + count + " items", "success");
  } else {
    const filenames = Array.from(selectedFiles);
    showLoading(true, "Updating Database...");
    for (const fn of filenames) {
      const entry = dbEntries.find(e => e.filename === fn);
      if (!entry) {showLoading(false);showToast("A selected crop is unavailable. Refresh the database before applying labels.", "error");return;}
      try { await persistEditedItem(entry, label); } catch (error) { showLoading(false); showToast(error.message, "error"); return; }
      if (entry) {
        entry.label = label;
        if (label && (entry.id.includes("bank") || entry.id.includes("bet") || entry.id.includes("pot"))) {
          const curMatch = label.match(/[GS] /); if (curMatch) gameCurrencyMap[entry.game_id] = curMatch[0].trim();
        }
      }
    }
    document.getElementById(inputId).value = ""; selectedFiles.clear();dbSelectedMetadata.clear();if(window.CollectorBackgroundLists) await refreshDatabase();renderDatabase();
    showLoading(false); showToast("Applied label to " + filenames.length + " items", "success");
  }
};

function updateReviewBulkUI() {
  const bulkControls = document.getElementById("review-bulk-controls");
  const deleteBtn = document.getElementById("btn-delete-session-selected");
  const bulkInput = document.getElementById("review-bulk-label-input");
  const bulkBtn = document.getElementById("btn-review-bulk-label");
  const selectedItems=typeof isFullSessionReview==='function' && isFullSessionReview() ? fullReviewSelection() : Array.from(selectedPoolIndices).map(idx=>pool[idx]).filter(Boolean);
  const selectedCount=selectedItems.length;
  if(typeof isFullSessionReview==='function' && isFullSessionReview() && fullSessionReview) {
    updateReviewSelectShown(fullReviewItems().slice(0,100),item=>fullSessionReview.selected.has(sampleKey(item)),fullSessionReview.mutation);
  } else {
    const search=document.getElementById('review-search').value.toLowerCase();
    const applicable=pool.map((e,originalIdx)=>({...e,originalIdx})).filter(e=>e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search)));
    updateReviewSelectShown(applicable,e=>selectedPoolIndices.has(e.originalIdx));
  }

  if (selectedCount > 1) {
    const commonType = getCommonRegionType(selectedItems);
    if (commonType) bulkControls.classList.remove("hidden"); else bulkControls.classList.add("hidden");
  } else {
    bulkControls.classList.add("hidden");
  }

  if (selectedCount > 0) {
    deleteBtn.classList.remove("hidden");
    deleteBtn.textContent = "Remove " + selectedCount + " Selected";
  } else { deleteBtn.classList.add("hidden"); }

  if (bulkBtn && bulkInput) {
    bulkBtn.disabled = bulkInput.value.trim() === "" || selectedCount < 2 || !!(typeof fullSessionReview!=='undefined' && fullSessionReview?.mutation);
  }
  updateBulkDatalist('review');
}

function renderNoSearchMatches(container) {
  const message = document.createElement('p');
  message.className = 'search-empty';
  message.setAttribute('role', 'status');
  message.textContent = 'No crops match your search. Try a region ID or clear the search.';
  container.appendChild(message);
}

function renderSessionReview() {
  const fullReview=typeof isFullSessionReview==='function' && isFullSessionReview();
  document.getElementById('review-filter')?.classList.toggle('hidden',!fullReview);
  document.querySelector('.review-page-bar')?.classList.toggle('hidden',!fullReview || !!window.CollectorBackgroundLists);document.querySelector('.review-page-footer')?.classList.toggle('hidden',!fullReview || !!window.CollectorBackgroundLists);
  if(fullReview) return renderFullSessionReview();
  const hud = document.getElementById("session-review-hud");
  if (!pool.length) { setView('collection'); return; }
  hud.classList.remove("hidden");
  updateReviewBulkUI();
  const search = document.getElementById("review-search").value.toLowerCase();
  const filtered = pool.map((e, idx) => ({...e, originalIdx: idx})).filter(e => e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search)));
  updateReviewSelectShown(filtered,e=>selectedPoolIndices.has(e.originalIdx));
  const sorted = filtered.sort((a, b) => (a.discarded === b.discarded ? 0 : (a.discarded ? 1 : -1)));
  const dataList = document.getElementById("review-search-list");
  const suggestions = new Set(); pool.forEach(e => { suggestions.add(e.id); if (e.label) suggestions.add(e.label); });

  // Add hardcoded statuses to suggestions
  const statusSchema = SchemaRegistry.getSchema("status_0");
  if (statusSchema === Schemas.STATUS) {
    statusSchema.allowed.forEach(s => suggestions.add(s));
  }

  dataList.innerHTML = Array.from(suggestions).sort().map(s => "<option value='" + s + "'>").join('');
  if(window.CollectorBackgroundLists) {
    sessionReviewListEl.classList.add("instant-list-host");
    window.CollectorBackgroundLists.snapshot(sessionReviewListEl,{items:sorted,key:e=>`${sampleKey(e)}:${e.originalIdx}`,card:e=>{
      const card=renderCard({imageSrc:cropImage(e),label:e.label,id:e.id,originalIdx:e.originalIdx,historyItem:e,isSelected:selectedPoolIndices.has(e.originalIdx),isIgnored:e.discarded,isBlank:e.reviewed && e.label==='' && !e.discarded,isEditing:editingPoolIdx===e.originalIdx,onToggle:()=>togglePoolSelection(e.originalIdx),onEdit:()=>startEditingSessionLabel(e.originalIdx),onRemove:()=>removeSessionItem(e.originalIdx),removeLabel:'Remove',onSave:()=>saveSessionLabel(e.originalIdx),onKeydown:event=>handleSessionEditKey(event,e.originalIdx)});
      const input=card.querySelector('input.card-label'),key=sampleKey(e);if(input){if(legacyReviewDrafts.has(key)) input.value=legacyReviewDrafts.get(key);input.oninput=()=>legacyReviewDrafts.set(key,input.value);}return card;
    }});return;
  }
  sessionReviewListEl.innerHTML = "";
  if (!sorted.length) renderNoSearchMatches(sessionReviewListEl);
  sorted.forEach(e => {
    const card = renderCard({ imageSrc: cropImage(e), label: e.label, id: e.id, originalIdx: e.originalIdx, isSelected: selectedPoolIndices.has(e.originalIdx), isIgnored: e.discarded, isBlank: e.reviewed && e.label === '' && !e.discarded, isEditing: editingPoolIdx === e.originalIdx,
      onToggle: () => togglePoolSelection(e.originalIdx), onEdit: () => startEditingSessionLabel(e.originalIdx), onRemove: () => removeSessionItem(e.originalIdx), removeLabel: 'Remove', onSave: () => saveSessionLabel(e.originalIdx), onKeydown: (event) => handleSessionEditKey(event, e.originalIdx) });
    sessionReviewListEl.appendChild(card);
  });
}

function startEditingSessionLabel(idx) {
  editingPoolIdx = idx;
  updateEditDatalist(pool[idx]);
  renderSessionReview();
  datasetTimeout(() => { const input = document.getElementById("edit-input-" + idx); if (input) { input.focus({preventScroll:true}); input.select(); } }, 50);
}
async function saveSessionLabel(idx) {
  const input = document.getElementById("edit-input-" + idx);
  if (input) {
    const item = pool[idx]; const oldLabel = item.label; const newLabel = input.value.trim();
    const category = item.id.includes("name") ? "name" : (item.id.includes("status") ? "status" : null);
    try { await persistEditedItem(item, newLabel); } catch (error) { showToast(error.message, "error"); return; }
    item.discarded = false; syncPoolsWithLabelChange(oldLabel, newLabel, category);
  }
  legacyReviewDrafts.delete(sampleKey(pool[idx]));editingPoolIdx = -1; saveSessionProgress(); updateStepperButtons(); renderSessionReview();
}
function handleSessionEditKey(e, idx) { if (e.key === "Enter") { e.preventDefault(); saveSessionLabel(idx); } else if (e.key === "Escape") { e.preventDefault(); editingPoolIdx = -1; renderSessionReview(); } }
async function removeSessionItem(idx) { if (await showConfirmModal("Remove Item", "Remove this region from the current session?")) { const item = pool[idx]; if(queueMode) {await discardQueue({sample_keys:[sampleKey(item)]});selectedPoolIndices.delete(idx);renderSessionReview();return;} if (item.watch) { try { await datasetFetch('/api/watch/discard',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_keys:[sampleKey(item)]})}); } catch(error) { showToast(error.message,'error'); return; } } pool.splice(idx, 1); prunePoolsForItem(item); selectedPoolIndices.delete(idx); saveSessionProgress(); renderSessionReview(); updateStepperButtons(); } }
function togglePoolSelection(idx) {
  if (selectedPoolIndices.has(idx)) selectedPoolIndices.delete(idx);
  else selectedPoolIndices.add(idx);

  // Surgical Update
  const card = sessionReviewListEl.querySelector(`.card[data-original-idx="${idx}"]`);
  if (card) {
    card.classList.toggle('selected', selectedPoolIndices.has(idx));
    const cb = card.querySelector('.card-checkbox');
    if (cb) cb.checked = selectedPoolIndices.has(idx);
  }
  updateReviewBulkUI();
}

function updateDbBulkUI() {
  const bulkControls = document.getElementById("db-bulk-controls");
  const deleteBtn = document.getElementById("btn-delete-db-selected");
  const deselectAllBtn = document.getElementById("btn-db-deselect-all");
  const bulkInput = document.getElementById("db-bulk-label-input");
  const bulkBtn = document.getElementById("btn-db-bulk-label");

  if (selectedFiles.size > 1) {
    const selectedItems = Array.from(selectedFiles).map(fn => dbEntries.find(e => e.filename === fn)).filter(Boolean);
    const commonType = getCommonRegionType(selectedItems);
    if (commonType) bulkControls.classList.remove("hidden"); else bulkControls.classList.add("hidden");
  } else {
    bulkControls.classList.add("hidden");
  }

  if (selectedFiles.size > 0) {
    deleteBtn.classList.remove("hidden"); deselectAllBtn.classList.remove("hidden");
    deleteBtn.textContent = "Remove " + selectedFiles.size + " Selected"; deselectAllBtn.textContent = "Deselect " + selectedFiles.size;
  } else { deleteBtn.classList.add("hidden"); deselectAllBtn.classList.add("hidden"); }

  if (bulkBtn && bulkInput) {
    bulkBtn.disabled = bulkInput.value.trim() === "" || selectedFiles.size < 2;
  }
  updateBulkDatalist('database');
}

function renderDatabase() {
  if(window.CollectorBackgroundLists && activeDatasetId) {
    const hud=document.getElementById("database-hud"),empty=document.getElementById("database-empty");
    const epoch=datasetEpoch,datasetId=activeDatasetId, search=document.getElementById("db-search").value.trim();
    dbListEl.classList.add("instant-list-host");document.getElementById("db-pagination").classList.add("hidden");
    window.CollectorBackgroundLists.render(dbListEl,{path:"/api/db_entries",datasetId,query:{search},key:item=>item.filename,
      card:e=>{ const card=renderCard({imageSrc:scopedImage(`/api/db_image/${encodeURIComponent(e.filename)}`),label:e.label,id:e.id,filename:e.filename,originalIdx:e.filename,isSelected:selectedFiles.has(e.filename),isBlank:e.label==='',isEditing:editingPoolIdx===e.filename,onToggle:()=>toggleDbSelection(e.filename,e),onEdit:()=>startEditingDbLabel(e.filename),onRemove:()=>deleteDbEntry(e.filename),removeLabel:'Remove',onSave:()=>saveDbLabel(e.filename),onKeydown:event=>handleDbEditKey(event,e.filename)});const input=card.querySelector('input.card-label');if(input){if(dbDrafts.has(e.filename)) input.value=dbDrafts.get(e.filename);input.oninput=()=>dbDrafts.set(e.filename,input.value);}return card;},
      changed:(items,meta,loading,error,total)=>{ if(epoch!==datasetEpoch || datasetId!==activeDatasetId) return;
        const old=new Map(dbEntries.map(item=>[item.filename,item]));
        for(const filename of selectedFiles) if(old.has(filename) && !dbSelectedMetadata.has(filename)) dbSelectedMetadata.set(filename,old.get(filename));
        dbEntries=items.map(item=>Object.assign(old.get(item.filename) || {},item));
        for(const item of dbEntries) if(selectedFiles.has(item.filename)) dbSelectedMetadata.set(item.filename,item);
        for(const [filename,item] of dbSelectedMetadata) if(!dbEntries.some(entry=>entry.filename===filename)) dbEntries.push(item);
        if(!search) dbTotal=total;hud.classList.toggle("hidden",!total && !search && !loading && !error);empty.classList.toggle("hidden",!!total || !!search || loading || error);
        document.getElementById("count-db").textContent=String(total);document.getElementById("btn-db-select-all").classList.toggle("hidden",!total);
        updateDbBulkUI();updateStepperButtons();
      }});
    return;
  }
  const hud = document.getElementById("database-hud"); const empty = document.getElementById("database-empty");
  if (!dbEntries.length) { hud.classList.add("hidden"); empty.classList.remove("hidden"); return; }
  hud.classList.remove("hidden"); empty.classList.add("hidden");
  updateDbBulkUI();
  const search = document.getElementById("db-search").value.toLowerCase();
  const filtered = dbEntries.filter(e => e.id.toLowerCase().includes(search) || (e.label && e.label.toLowerCase().includes(search)));
  const sorted = filtered.sort((a, b) => { const aIgnored = !a.label || a.label === ""; const bIgnored = !b.label || b.label === ""; if (aIgnored === bIgnored) return 0; return aIgnored ? 1 : -1; });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / dbPageSize));
  if (dbPage > totalPages) dbPage = totalPages;
  const startIdx = (dbPage - 1) * dbPageSize;
  const pageItems = sorted.slice(startIdx, startIdx + dbPageSize);
  window.CollectorScroll?.remember('database', activeDatasetId, {page:dbPage,search:document.getElementById('db-search').value});

  document.getElementById("db-page-info").textContent = `Page ${dbPage} of ${totalPages}`;
  document.getElementById("btn-db-prev").disabled = dbPage <= 1;
  document.getElementById("btn-db-next").disabled = dbPage >= totalPages;
  document.getElementById("db-pagination").classList.toggle("hidden", totalPages <= 1);

  const selectAllBtn = document.getElementById("btn-db-select-all");
  if (search.length > 0 && filtered.length > 0) selectAllBtn.classList.remove("hidden"); else selectAllBtn.classList.add("hidden");
  const dataList = document.getElementById("db-search-list");
  const suggestions = new Set(); dbEntries.forEach(e => { suggestions.add(e.id); if (e.label) suggestions.add(e.label); });

  // Add hardcoded statuses to suggestions
  const statusSchema = SchemaRegistry.getSchema("status_0");
  if (statusSchema === Schemas.STATUS) {
    statusSchema.allowed.forEach(s => suggestions.add(s));
  }

  dataList.innerHTML = Array.from(suggestions).sort().map(s => "<option value='" + s + "'>").join('');
  dbListEl.innerHTML = ""; document.getElementById("count-db").textContent = dbEntries.length;
  if (!pageItems.length) renderNoSearchMatches(dbListEl);
  pageItems.forEach(e => {
    const isEditing = editingPoolIdx === e.filename;
    const card = renderCard({ imageSrc: scopedImage(`/api/db_image/${encodeURIComponent(e.filename)}`), label: e.label, id: e.id, filename: e.filename, originalIdx: e.filename, isSelected: selectedFiles.has(e.filename), isBlank: e.label === '', isEditing: isEditing,
      onToggle: () => toggleDbSelection(e.filename), onEdit: () => startEditingDbLabel(e.filename), onRemove: () => deleteDbEntry(e.filename), removeLabel: 'Remove', onSave: () => saveDbLabel(e.filename), onKeydown: (event) => handleDbEditKey(event, e.filename) });
    dbListEl.appendChild(card);
  });
}

function createDbSuggestionPanel(filename) {
  const panel = document.createElement('section');
  panel.className = 'card-info saved-model-assist'; panel.id = `db-model-${filename}`;
  panel.setAttribute('aria-label', 'Local model suggestion');
  const status = document.createElement('p'); status.id = `db-model-state-${filename}`;
  const text = document.createElement('p'); text.id = `db-model-text-${filename}`;
  const raw = document.createElement('p'); raw.id = `db-model-raw-${filename}`;
  panel.append(status, text, raw);
  for (const [name, title, handler, primary] of [
    ['retry', 'Suggest', () => requestDbSuggestion(filename), false],
    ['use', 'Use and edit', () => useDbSuggestion(filename), false],
    ['accept', 'Accept', () => acceptDbSuggestion(filename), true]
  ]) {
    const button = document.createElement('button');
    button.id = `db-model-${name}-${filename}`; button.type = 'button';
    button.className = primary ? 'btn-primary' : 'btn-secondary';
    button.textContent = title; button.onclick = handler;
    button.disabled = name !== 'retry'; panel.appendChild(button);
  }
  panel.onkeydown = event => { if (event.ctrlKey) handleDbEditKey(event, filename); };
  // Rendering is synchronous; the panel will be attached before this task runs.
  datasetTimeout(() => renderDbSuggestion(filename), 0);
  return panel;
}
function renderDbSuggestion(filename) {
  const entry = dbEntries.find(item => item.filename === filename);
  const panel = document.getElementById(`db-model-${filename}`);
  if (!entry || !panel || editingPoolIdx !== filename) return;
  const prediction = entry.prediction;
  panel.setAttribute('aria-busy', String(!!entry.model_loading || dbReviewSaving));
  panel.setAttribute('data-state', entry.model_loading ? 'loading' : entry.model_error ? 'error' : prediction ? prediction.schema_valid ? 'ready' : 'invalid' : 'idle');
  const status = document.getElementById(`db-model-state-${filename}`);
  if (status) status.textContent = entry.model_loading ? 'Loading local model…' : entry.model_error || (prediction ? prediction.schema_valid ? 'Ready for review · Ctrl+Enter accepts' : 'Invalid format · correction required' : 'Request a suggestion for this saved crop');
  const text = document.getElementById(`db-model-text-${filename}`);
  if (text) text.textContent = prediction ? prediction.text : '';
  const raw = document.getElementById(`db-model-raw-${filename}`);
  if (raw) raw.textContent = prediction ? prediction.raw_text === '' ? '(blank)' : prediction.raw_text ?? '—' : '';
  const use = document.getElementById(`db-model-use-${filename}`);
  const accept = document.getElementById(`db-model-accept-${filename}`);
  const retry = document.getElementById(`db-model-retry-${filename}`);
  if (use) use.disabled = !prediction || dbReviewSaving || entry.model_loading;
  if (accept) accept.disabled = !prediction?.schema_valid || dbReviewSaving || entry.model_loading;
  if (retry) retry.disabled = dbReviewSaving || entry.model_loading;
}
async function requestDbSuggestion(filename) {
  const entry = dbEntries.find(item => item.filename === filename);
  if (!entry || editingPoolIdx !== filename || dbReviewSaving) return;
  const epoch = datasetEpoch, requestId = ++dbSuggestionRequest;
  entry.model_loading = true; entry.model_error = ''; renderDbSuggestion(filename);
  try {
    const data = await (await datasetFetch('/api/model_suggestion', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({sample_key:sampleKey(entry),filename,id:entry.id})})).json();
    if (epoch !== datasetEpoch || requestId !== dbSuggestionRequest || editingPoolIdx !== filename || currentView !== 'database') return;
    if (!data.prediction) throw new Error(data.error || 'No suggestion returned');
    entry.prediction = data.prediction; entry.prediction_id = data.prediction.id;
  } catch (error) {
    if (epoch === datasetEpoch && requestId === dbSuggestionRequest && editingPoolIdx === filename) entry.model_error = `Model unavailable: ${error.message}`;
  } finally {
    if (epoch === datasetEpoch && requestId === dbSuggestionRequest && editingPoolIdx === filename) { entry.model_loading = false; renderDbSuggestion(filename); }
  }
}
function useDbSuggestion(filename) {
  const entry = dbEntries.find(item => item.filename === filename);
  const input = document.getElementById(`edit-input-${filename}`);
  if (!entry?.prediction || entry.model_loading || !input || dbReviewSaving || editingPoolIdx !== filename) return;
  input.value = entry.prediction.text ?? '';
  input.focus({preventScroll:true}); input.select();
}
async function acceptDbSuggestion(filename) {
  const entry = dbEntries.find(item => item.filename === filename);
  if (!entry?.prediction?.schema_valid || entry.model_loading || dbReviewSaving || editingPoolIdx !== filename) return;
  await saveDbLabel(filename, entry.prediction.text ?? '', 'accept');
}
function startEditingDbLabel(filename) {
  dbSuggestionRequest++; editingPoolIdx = filename;
  const entry = dbEntries.find(item => item.filename === filename);
  if (!entry) return;
  entry.prediction = null; entry.prediction_id = null; entry.model_loading = false; entry.model_error = '';
  updateEditDatalist(entry); renderDatabase();
  datasetTimeout(() => { const input = document.getElementById(`edit-input-${filename}`); if (input) { input.focus({preventScroll:true}); input.select(); } }, 50);
  requestDbSuggestion(filename);
}
async function saveDbLabel(filename, suggestedLabel, action = 'correct') {
  if (dbReviewSaving || datasetSwitching || editingPoolIdx !== filename) return;
  const input = document.getElementById(`edit-input-${filename}`);
  const entry = dbEntries.find(item => item.filename === filename);
  if (!input || !entry) return;
  const epoch = datasetEpoch;
  dbReviewSaving = true; renderDbSuggestion(filename);
  try {
    await persistEditedItem(entry, suggestedLabel === undefined ? input.value.trim() : suggestedLabel, action);
    if (epoch !== datasetEpoch || editingPoolIdx !== filename) return;
    dbDrafts.delete(filename);editingPoolIdx = -1; dbSuggestionRequest++; if(window.CollectorBackgroundLists) await refreshDatabase();renderDatabase();
  } catch (error) { if (epoch === datasetEpoch) showToast(error.message, 'error'); }
  finally { if (epoch === datasetEpoch) { dbReviewSaving = false; renderDbSuggestion(filename); } }
}
function handleDbEditKey(event, filename) {
  const acceptPrediction = event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'Enter';
  const editPrediction = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'Tab';
  if (acceptPrediction || editPrediction) {
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    if (acceptPrediction) acceptDbSuggestion(filename); else useDbSuggestion(filename);
  } else if (event.ctrlKey || event.altKey || event.metaKey) {
    return;
  } else if (event.key === 'Enter') {
    event.preventDefault(); if (!event.repeat) saveDbLabel(filename);
  } else if (event.key === 'Escape') {
    event.preventDefault(); dbDrafts.delete(filename); dbSuggestionRequest++; editingPoolIdx = -1; renderDatabase();
  }
}
function toggleDbSelection(filename, entry = dbEntries.find(item=>item.filename===filename)) {
  if (selectedFiles.has(filename)) {selectedFiles.delete(filename);dbSelectedMetadata.delete(filename);}
  else {
    if(!entry) return;
    selectedFiles.add(filename);dbSelectedMetadata.set(filename,entry);
  }

  // Surgical Update
  const card = dbListEl.querySelector(`.card[data-filename="${filename}"]`);
  if (card) {
    card.classList.toggle('selected', selectedFiles.has(filename));
    const cb = card.querySelector('.card-checkbox');
    if (cb) cb.checked = selectedFiles.has(filename);
  }
  updateDbBulkUI();
}

async function deleteDbEntry(fn) {
  if (await showConfirmModal("Remove from Database", "Permanently remove this entry from database? This action is IRREVERSIBLE.")) {
    const r = await datasetFetch("/api/db_delete", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ filename: fn })
    });
    const d = await r.json();
    showToast(d.message, "success");
    await refreshDatabase();
  }
}

const workflowSteps = ['collection','labeling','session-review','database'];
function workflowAvailability() {
  const views = {
    collection: !labelingUnlocked && !reviewUnlocked,
    labeling: !reviewUnlocked && labelingUnlocked && pool.length > 0,
    'session-review': !!(reviewUnlocked && (pool.length > 0 || isContinuousReview() && streamStats?.total > 0)),
    database: window.CollectorBackgroundLists ? dbTotal > 0 : dbEntries.length > 0,
  };
  const busy = queueLoading || reviewBatchLoading || queueCommitBusy || labelingEntryBusy || reviewSaving || datasetSwitching || isRecovering;
  const available = queueMode ? !!queueSummary?.total : frames.length > 0 || pool.length > 0;
  const canRecover = !!(captureWatch?.isActive() || captureWatch?.isBusy() || watchNeedsRecovery);
  const canStart = currentView === 'collection' && !reviewUnlocked && (available || canRecover);
  return {views, startLabeling:!busy && canStart, navigateLabeling:!busy && (views.labeling || canStart)};
}
function isViewDisabled(v) { return workflowAvailability().views[v] === false; }
function firstEnabledWorkflow() {
  const availability = workflowAvailability().views;
  return workflowSteps.find(view => availability[view]);
}

function updateStepperButtons() {
  renderCapturePresentation();
  const watchStart = document.getElementById('watch-start');
  if (watchStart) watchStart.disabled = !!(captureWatch?.isBusy() || manualCaptureBusy || datasetSwitching || isRecovering || labelingUnlocked || reviewUnlocked || queueMode && queueSummary?.total >= 5000);
  const availability = workflowAvailability();
  for (const view of workflowSteps) {
    const button=document.getElementById(`nav-${view}`);
    button.disabled = view === 'labeling' ? !availability.navigateLabeling : !availability.views[view];
    const current=view===currentView && availability.views[view];
    button.classList.toggle('btn-primary',current);
    button.classList.toggle('btn-secondary',!current);
    if(current) button.setAttribute('aria-current','step');
    else button.removeAttribute('aria-current');
  }

  updateQueueControls();

  const btnStatsReview = document.getElementById("btn-stats-review");
  if (btnStatsReview) {
    const allComplete = isContinuousReview() ? !!streamStats?.complete && !reviewBatch.next_cursor : pool.length > 0 && pool.every(item => (item.label && item.label.trim() !== "") || item.reviewed || item.discarded);
    btnStatsReview.disabled = !allComplete || reviewUnlocked;

    if (!allComplete) {
        btnStatsReview.textContent = "Finish labeling to review";
        btnStatsReview.classList.replace("btn-success", "btn-secondary");
    } else {
        btnStatsReview.textContent = reviewUnlocked ? "Review unlocked" : "Continue to review";
        btnStatsReview.classList.replace("btn-secondary", "btn-success");
    }
  }
}

const setView = (v, pushState = true) => {
  if (v !== 'collection' && (captureWatch?.isActive() || captureWatch?.isBusy() || watchNeedsRecovery)) {
    void stopAndRecoverWatch('Collection paused').then(() => { if (!watchNeedsRecovery) setView(v,pushState); }).catch(error => showToast(error.message,'error'));
    return;
  }
  if (isViewDisabled(v)) {
    if (pushState && !isViewDisabled(currentView)) {
      if (!isRecovering) showToast("Requested view is empty.", "error");
      return;
    }
    v = firstEnabledWorkflow();
    if (!v) return;
  }

  if (currentView === 'collection' && v !== 'collection') window.CollectorSharedUi?.closeMenus?.();
  if (currentView === 'session-review' && v !== 'session-review' && typeof resetFullSessionReview === 'function') {
    resetFullSessionReview(true);
    window.CollectorBackgroundLists?.clear(sessionReviewListEl);
    window.CollectorSharedUi?.disposeMenus?.(sessionReviewListEl);
    sessionReviewListEl?.replaceChildren();
  }
  if(queueMode && v==='labeling') {
    if(window.CollectorBackgroundLists && frameListEl) window.CollectorBackgroundLists.clear(frameListEl);
    if(window.CollectorBackgroundLists && dbListEl) window.CollectorBackgroundLists.clear(dbListEl);
    window.CollectorSharedUi?.disposeMenus?.(frameListEl);
    frameListEl?.replaceChildren();collectionItems=[];
    dbListEl?.replaceChildren();sessionReviewListEl?.replaceChildren();
  }

  if (currentView === 'labeling' && v !== 'labeling') { leaveReviewClock(); clearModelTextTransition(); if (typeof clearGamificationEffects === 'function') clearGamificationEffects(); }
  window.CollectorScroll?.navigate(v, activeDatasetId);
  if (!window.CollectorScroll && currentView !== v) {
    const scrollRegion = document.getElementById('main-content');
    if (scrollRegion) scrollRegion.scrollTop = 0;
  }
  currentView = v;
  document.getElementById('dataset-tools').classList.toggle('hidden', v !== 'collection' && v !== 'database');
  if (v !== 'collection') document.getElementById('dataset-manager').open = false;
  const views = { 'collection': viewCollection, 'labeling': viewLabeling, 'session-review': viewSessionReview, 'database': viewDatabase };
  Object.values(views).forEach(el => { el.classList.remove("active-view"); });
  const targetView = views[v];
  if (targetView) { targetView.classList.remove("hidden"); targetView.offsetHeight; targetView.classList.add("active-view"); }
  Object.entries(views).forEach(([name, el]) => { if (name !== v) el.classList.add("hidden"); });

  if (pushState) {
    let path = v === 'session-review' ? 'review' : v; if (v === 'labeling') path = "labeling/" + ((queueMode ? reviewBatch?.legacy_offset || 0 : 0) + currentReviewIdx + 1);
    const state={view:v,idx:v==='labeling'?currentReviewIdx:null,...(queueMode?{dataset_id:activeDatasetId,batch_id:reviewBatch?.batch_id,sample_key:pool[currentReviewIdx]?sampleKey(pool[currentReviewIdx]):null}:{})};
    if(window.location?.pathname==='/gameplay') window.pokerOcrDeferredLocation={path:"/"+path,state};
    else history.pushState(state,'',"/"+path);
    window.dispatchEvent?.(new Event('poker-ocr-location'));
  }

  if (!isRecovering) saveSessionProgress();
  ['nav-collection','nav-labeling','nav-session-review','nav-database'].forEach(id => { const btn = document.getElementById(id); btn.classList.remove("btn-primary"); btn.classList.add("btn-secondary"); });

  if (v === 'collection') {
    if(queueMode && window.CollectorBackgroundLists) renderFrames();
    else if(queueMode && !collectionItems.length && queueSummary?.total && !queueLoading) void loadCollectionPage(collectionCursor).catch(error=>showToast(error.message,'error'));
    viewCollection.classList.remove("hidden");
    document.getElementById("nav-collection").classList.add("btn-primary");
    document.getElementById("nav-collection").classList.remove("btn-secondary");
  }
  else if (v === 'labeling') {
    const completed = isContinuousReview() && streamStats?.complete && !reviewBatch.next_cursor && queueCompletedResult?.run_id===reviewBatch.batch_id;
    if(completed) void showLabelingStats().catch(error=>showToast(error.message,'error'));
    else processPool();
    if (pool.length === 0) {
      // If pool is empty after processing, we can't label.
      setView('collection', false);
      if (pushState) showToast("No new unique regions to label.", "error");
    }
    else {
      viewLabeling.classList.remove("hidden");
      document.getElementById("nav-labeling").classList.add("btn-primary");
      document.getElementById("nav-labeling").classList.remove("btn-secondary");
      datasetTimeout(() => { if (pool.length && !completed) labelInput.focus({preventScroll:true}); }, 50);
    }
  }
  else if (v === 'session-review') {
    renderSessionReview();
    if (pool.length === 0 && !(isContinuousReview() && streamStats?.total>0)) {
      setView('collection', false);
      if (pushState) showToast("No active data in session.", "error");
    }
    else {
      viewSessionReview.classList.remove("hidden");
      document.getElementById("nav-session-review").classList.add("btn-primary");
      document.getElementById("nav-session-review").classList.remove("btn-secondary");
    }
  }
  else if (v === 'database') {
    loadDatabase();
    viewDatabase.classList.remove("hidden");
    document.getElementById("nav-database").classList.add("btn-primary");
    document.getElementById("nav-database").classList.remove("btn-secondary");
    if (datasetStorage.getItem("db_dashboard_open") === "true") {
        toggleDbStats(true);
    } else {
        toggleDbStats(false);
    }
  }
  updateStepperButtons();
  if(typeof syncAiReviewView==='function') syncAiReviewView();
};

window.onpopstate = (e) => {
  if (e.state && e.state.view) {
    if(queueMode && ((e.state.dataset_id && e.state.dataset_id!==activeDatasetId) || e.state.view==='labeling' && (e.state.batch_id!==reviewBatch?.batch_id || !pool.some(item=>sampleKey(item)===e.state.sample_key)))) {
      const path=currentView==='labeling'?`labeling/${(reviewBatch?.legacy_offset || 0)+currentReviewIdx+1}`:currentView==='session-review'?'review':currentView;
      history.replaceState({view:currentView,idx:currentReviewIdx,dataset_id:activeDatasetId,batch_id:reviewBatch?.batch_id,sample_key:pool[currentReviewIdx]?sampleKey(pool[currentReviewIdx]):null},'','/'+path);
      return;
    }
    if (isViewDisabled(e.state.view)) {
      history.replaceState({view: currentView, idx: currentReviewIdx}, '', window.location.pathname);
      return;
    }
    if (e.state.view === 'labeling' && e.state.idx !== undefined && e.state.idx !== null) {
      const index=queueMode ? pool.findIndex(item=>sampleKey(item)===e.state.sample_key) : e.state.idx;
      if (currentReviewIdx !== index) leaveReviewClock();
      currentReviewIdx = index;
    }
    setView(e.state.view, false);
  }
};

let viewportReadiness = null;
async function waitForCurrentViewport() {
  if (!window.CollectorBackgroundLists?.waitForViewport) return;
  viewportReadiness?.abort();
  const owner = new AbortController(); viewportReadiness = owner;
  try {
    while (!owner.signal.aborted) {
      if (window.location.pathname === '/gameplay') await new Promise(resolve => {
        const changed = () => { if (owner.signal.aborted || window.location.pathname !== '/gameplay') { window.removeEventListener('poker-workspace-change', changed); owner.signal.removeEventListener('abort', changed); resolve(); } };
        window.addEventListener('poker-workspace-change', changed);
        owner.signal.addEventListener('abort', changed, {once:true});
      });
      if (owner.signal.aborted) return;
      const controller = new AbortController();
      const changed = () => { if (owner.signal.aborted || window.location.pathname === '/gameplay') controller.abort(); };
      window.addEventListener('poker-workspace-change', changed);
      owner.signal.addEventListener('abort', changed, {once:true});
      const host = currentView === 'collection' ? frameListEl : currentView === 'database' ? dbListEl : currentView === 'session-review' ? sessionReviewListEl : viewLabeling;
      let ready;
      try { ready = !host || await window.CollectorBackgroundLists.waitForViewport(host, controller.signal); }
      finally { window.removeEventListener('poker-workspace-change', changed); owner.signal.removeEventListener('abort', changed); }
      if (owner.signal.aborted) return;
      if (controller.signal.aborted) continue;
      if (!ready) showToast('The first view is taking longer than expected. You can retry loading the list.', 'error');
      return;
    }
  } finally { if (viewportReadiness === owner) viewportReadiness = null; }
}

async function probeDatabaseAvailability() {
  if (!window.CollectorBackgroundLists) return;
  const datasetId = activeDatasetId, controller = new AbortController();
  let timer;
  try {
    const page = await Promise.race([
      window.CollectorBackgroundLists.readPages('/api/db_entries',datasetId,{},'database',false,controller.signal),
      new Promise((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Database availability timed out')); },3000); })
    ]);
    if (activeDatasetId === datasetId) dbTotal = Math.max(dbTotal,page.items.length);
  } catch (error) { console.warn('Database availability unavailable',error); }
  finally { clearTimeout(timer); }
}

async function init() {
  const startupPath = window.pokerOcrStartupPath || window.location.pathname;
  initDom();
  window.CollectorScroll?.start();
  if(typeof initAiReview==='function') initAiReview();
  await initDatasets();
  const savedCollection = window.CollectorScroll?.recall('collection', activeDatasetId);
  const savedDatabase = window.CollectorScroll?.recall('database', activeDatasetId);
  if (savedDatabase) {
    dbPage = Math.max(1, Number(savedDatabase.page) || 1);
    document.getElementById('db-search').value = savedDatabase.search || '';
  }
  if (window.location.pathname !== '/gameplay') showLoading(true, "Initializing Engine...");
  try {
    let syncStatus = await (await datasetFetch("/api/sync_status")).json();
    while (syncStatus.is_syncing) { const progress = syncStatus.total > 0 ? (syncStatus.progress / syncStatus.total) * 100 : 0; updateLoadingProgress(syncStatus.current_action, progress); await new Promise(r => datasetTimeout(r, 500)); syncStatus = await (await datasetFetch("/api/sync_status")).json(); }
  } catch (e) { console.error("Sync check failed", e); }
  updateLoadingProgress("Fetching Data...", 90);
  try {
    const data = await (await datasetFetch(`/api/initial_data?queue_mode=paged${window.CollectorBackgroundLists?"&background_lists=1":""}`)).json();
    globalHistory = data.history || [];
    if(window.CollectorBackgroundLists) void refreshCompletionHistory(data.session).catch(error=>console.warn("History unavailable",error));
    loadMonitors(data.sources || data.monitors, data.settings.last_monitor); loadDatabase(data.db); void refreshNames(""); await recoverSession(data.session);
    if(queueMode) {if(savedCollection?.cursor) {collectionPrevious=Array.isArray(savedCollection.previous)?savedCollection.previous:[];await loadCollectionPage(savedCollection.cursor);}else if(data.collection_page) applyCollectionPage(data.collection_page);else await loadCollectionPage();renderFrames();}
  } catch (e) { throw new Error('Could not recover the collection: ' + e.message); }
  let initialView = 'collection'; const path = startupPath.replace(/^\/+/, '');
  if (path.startsWith('labeling')) {
    initialView = 'labeling';
    const parts = path.split('/');
    if (parts.length > 1) {
      const idx = parseInt(parts[1]);
      if (!isNaN(idx)) {
        const local=idx-1-(queueMode ? reviewBatch?.legacy_offset || 0 : 0);
        if(!queueMode || local>=0 && local<pool.length) currentReviewIdx=Math.max(0,local);
      }
    }
  } else if (path === 'review') initialView = 'session-review'; else if (path === 'database') initialView = 'database'; else if (path === 'collection') initialView = 'collection';
  const requestedView = initialView;
  await probeDatabaseAvailability();
  if (isViewDisabled(initialView)) initialView = firstEnabledWorkflow();
  if (!initialView) throw new Error('No workflow step is available.');
  const initialPath = initialView === requestedView ? startupPath : initialView === 'session-review' ? '/review' : initialView === 'labeling' ? '/labeling/' + ((queueMode ? reviewBatch?.legacy_offset || 0 : 0) + currentReviewIdx + 1) : '/' + initialView;
  setView(initialView, false); renderDatasetNavigator(); document.getElementById("collector-workspace").classList.add("ready"); updateStepperButtons(); const initialState = {view:currentView,idx:currentReviewIdx,...(queueMode?{dataset_id:activeDatasetId,batch_id:reviewBatch?.batch_id,sample_key:pool[currentReviewIdx]?sampleKey(pool[currentReviewIdx]):null}:{})}; if (window.location.pathname === startupPath && startupPath !== '/gameplay') { history.replaceState(initialState, '', initialPath); window.dispatchEvent?.(new Event('poker-ocr-location')); } else if (window.location.pathname === '/gameplay') window.pokerOcrDeferredLocation = {path:initialPath,state:initialState}; window.CollectorScroll?.restore(); await waitForCurrentViewport(); if (window.location.pathname !== '/gameplay') showLoading(false); window.pokerStartupTimedOut = false;
}

window.pokerOcrReady = init().catch(error => { if (window.location.pathname !== '/gameplay') showLoading(false); throw error; });

async function recoverSession(d) {
  if(d?.queue_mode==='paged') {
    queueMode=true;reviewBatch=d.review_batch || null;streamStats=d.review_stats || null;
    if(reviewBatch && reviewBatch.mode!=='stream') {
      const started=await (await datasetFetch('/api/queue/review/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json();
      d=started.session;reviewBatch=d.review_batch;streamStats=d.review_stats || started.review_stats || null;
    }
    streamCheckpointSequence=Math.max(streamCheckpointSequence,d.checkpoint_sequence || 0);
    const totals=d.queueCompletedStats;
    queueCompletedStats=totals && Number.isFinite(totals.items) && totals.items>=0 && Number.isFinite(totals.time) && totals.time>=0 ? {items:totals.items,time:totals.time} : {items:0,time:0};
    queueLastCommitReceipt=typeof d.queueLastCommitReceipt==='string' ? d.queueLastCommitReceipt : null;
    queueCompletionRecorded=d.queueCompletionRecorded===true;
    queueCompletedResult=typeof recoverCompletedResult==='function' ? recoverCompletedResult(d.queueCompletedResult,queueCompletionRecorded,d.sessionScore || 0) : null;
    applyQueueSummary(d.queue_summary);
  }
  if(d?.review_batch?.mode==='stream' && d.review_batch.committing && !d.pool?.length) {
    restoreReviewSessionRewards(d);quickLabels=d.quickLabels || 0;autoCompletes=d.autoCompletes || 0;isRecovering=false;
    await commitContinuousReview();return;
  }
  labelingUnlocked = d?.labelingUnlocked === true;
  reviewUnlocked = d?.reviewUnlocked === true;
  if (d && ((d.frames && d.frames.length) || (d.pool && d.pool.length))) {
    sessionStorage.removeItem("auto_restore:" + activeDatasetId);
    frames = d.frames || []; pool = d.pool || []; gameCurrencyMap = d.gameCurrencyMap || {}; currentReviewIdx = d.currentReviewIdx || 0;
    maxReachedIdx = d.maxReachedIdx || 0;
    await warmReviewImages();

    // Restore gamification state
    restoreReviewSessionRewards(d);
    if(queueMode) {const keys=new Set(pool.map(sampleKey));reviewAwards=Object.fromEntries(Object.entries(reviewAwards).filter(([key])=>keys.has(key)));}
    quickLabels = d.quickLabels || 0;
    autoCompletes = d.autoCompletes || 0;

    // Note: statusPool and usernamePool instances remain, we just populate them
    if (pool.length) {
      pool.forEach(item => {
        if (item.label && item.label.trim() && !item.discarded) {
          const l = item.label.trim();
          if (item.id.includes("name")) usernamePool.add(l);
          const curMatch = l.match(/^[GS] /) || l.match(/^Pot: [GS] /); if (curMatch) { const c = curMatch[0].includes("Pot: ") ? curMatch[0].split(" ")[1] : curMatch[0].trim(); gameCurrencyMap[item.game_id] = c; }
        }
      });
    }
    renderFrames();
    isRecovering = false;

    // Safety fallback: if pool exists, labeling must be unlocked
    if (!queueMode && pool.length > 0 && !labelingUnlocked && !reviewUnlocked) labelingUnlocked = true;

    updateStepperButtons();
  } else { isRecovering = false; }
}

function checkComboExpiration() {
  if (currentView !== 'labeling') return;
  const elapsed = reviewElapsed();
  const timerEl = document.getElementById("timer-display");
  
  if (timerEl) {
    const reason = reviewClockReason();
    timerEl.textContent = (elapsed / 1000).toFixed(3) + "s";
    timerEl.title = reason === 'editing' ? 'Editing paused' : reason === 'loading' ? 'Model loading' : reason ? 'Paused' : 'Read time';
    timerEl.setAttribute('aria-label', `${timerEl.title}: ${timerEl.textContent}`);
    if (elapsed > 5000) {
      timerEl.style.color = "var(--destructive)"; // Red (Expired)
    } else if (elapsed > 3000) {
      timerEl.style.color = "var(--game-combo-5)"; // Yellow (2s Warning)
    } else {
      timerEl.style.color = "var(--primary)"; // Green (Safe)
    }
  }

  const badgeEl = document.getElementById("combo-badge");
  const inputEl = document.getElementById("label-input");

  if (elapsed > 3000 && elapsed <= 5000) {
    if (badgeEl) badgeEl.classList.add("warning");
    if (inputEl) inputEl.classList.add("combo-warning");
  } else {
    if (badgeEl) badgeEl.classList.remove("warning");
    if (inputEl) inputEl.classList.remove("combo-warning");
  }

  // Live HUD update (color shifts, multiplier reset visuals)
  updateScoreDisplay();
}


function next() {
  if(isContinuousReview()) {void advanceContinuousReview();return;}
  if (currentReviewIdx < pool.length - 1) {
    const item = pool[currentReviewIdx];
    const isLabeled = (item.label && item.label.trim() !== "") || item.reviewed || item.discarded;

    // Only block if we are at the edge of progress
    if (!isLabeled && currentReviewIdx >= maxReachedIdx) {
        return;
    }

    leaveReviewClock();
    currentReviewIdx++;
    if (currentReviewIdx > maxReachedIdx) maxReachedIdx = currentReviewIdx;
    setView('labeling');
  }
}

function prev() {
  if (currentReviewIdx > 0) {
    leaveReviewClock();
    currentReviewIdx--;
    currentCombo = 0; // Original game rule: backward navigation resets the combo.
    updateScoreDisplay();
    setView('labeling');
  }
}






