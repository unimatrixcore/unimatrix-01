// Review the durable session independently of the small labeling look-behind buffer.
const FULL_REVIEW_PAGE_SIZE = 50, FULL_REVIEW_WINDOW_PAGES = 2;
let fullSessionReview = null, fullSessionReviewGeneration = 0;
let aiReviewedRowsRefresh = null;
const FULL_REVIEW_CHECKPOINT_KEY = 'collector:full-review-window';

function saveFullReviewCheckpoint(state) {
  if (!state?.ready || state.restoring || !fullReviewContextMatches(state)) return;
  try {
    sessionStorage.setItem(FULL_REVIEW_CHECKPOINT_KEY, JSON.stringify({datasetId:state.datasetId,runId:state.runId,
      search:state.search,filter:state.filter,cursors:state.cursors,indexes:state.pages.map(page=>page.index)}));
  } catch (_) { /* Storage may be unavailable; the current page still remains usable. */ }
}
function readFullReviewCheckpoint() {
  try {
    const saved=JSON.parse(sessionStorage.getItem(FULL_REVIEW_CHECKPOINT_KEY) || 'null');
    if(saved?.datasetId!==activeDatasetId || saved.runId!==reviewBatch?.batch_id ||
      typeof saved.search!=='string' || !['all','blank','pending','discarded','reviewed'].includes(saved.filter) ||
      !Array.isArray(saved.cursors) || !Array.isArray(saved.indexes) || !saved.indexes.length ||
      saved.indexes.length>FULL_REVIEW_WINDOW_PAGES ||
      saved.indexes.some((index,n)=>!Number.isInteger(index) || index<0 || (n && index!==saved.indexes[n-1]+1) || (index>0 && typeof saved.cursors[index]!=='string'))) return null;
    return saved;
  } catch (_) { return null; }
}
async function restoreFullReviewWindow(state, saved) {
  state.restoring=true;
  try {
    for(const index of saved.indexes) {
      if(!fullReviewContextMatches(state)) return;
      await loadFullReviewPage(index);
      if(state.error) break;
    }
  } finally {
    state.restoring=false;
    saveFullReviewCheckpoint(state);
  }
}

async function refreshAiReviewedRows(job) {
  if(!isContinuousReview() || job.run_id!==reviewBatch?.batch_id) return true;
  if(!job.corrected) return true;
  if(aiReviewedRowsRefresh) return false;
  const state=fullSessionReview,epoch=datasetEpoch,datasetId=activeDatasetId,runId=reviewBatch.batch_id;
  if(state && (state.editing || state.mutation || state.selected.size)) return false;
  const keys=[...new Set([...pool,...fullReviewItems()].map(sampleKey))];
  const current=()=>epoch===datasetEpoch && datasetId===activeDatasetId && runId===reviewBatch?.batch_id && !datasetSwitching;
  const task=(async()=>{
    const rows=new Map();let metadata=null;
    for(let offset=0;offset<keys.length;offset+=100) {
      metadata=await (await datasetFetch('/api/queue/review/metadata',{datasetId,method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({run_id:runId,sample_keys:keys.slice(offset,offset+100)})})).json();
      if(!current()) return true;
      for(const item of metadata.items) rows.set(sampleKey(item),item);
    }
    if(!current()) return true;
    if(fullSessionReview!==state || state && (state.editing || state.mutation || state.selected.size)) return false;
    for(const item of pool) {
      const fresh=rows.get(sampleKey(item));if(!fresh) continue;
      const prior=item.label;
      for(const field of ['label','reviewed','discarded','prediction_id']) item[field]=fresh[field];
      if(item.review_reward) item.review_reward={...item.review_reward,label:fresh.label};
      if(reviewAwards[sampleKey(item)]) reviewAwards[sampleKey(item)]={...reviewAwards[sampleKey(item)],label:fresh.label};
      if(prior!==fresh.label) syncPoolsWithLabelChange(prior,fresh.label,item.id.includes('name')?'name':null);
    }
    if(metadata?.summary) applyQueueSummary(metadata.summary);
    if(metadata?.review_stats) streamStats=metadata.review_stats;
    if(state && fullReviewContextMatches(state)) {
      if(state.search || state.filter!=='all') await refreshFullReviewWindow(state);
      else {
        for(const page of state.pages) for(const item of page.items) {
          const fresh=rows.get(sampleKey(item));if(fresh) Object.assign(item,fresh);
        }
        paintFullSessionReview();
      }
    }
    if(current()) await saveSessionProgress(true);
    return true;
  })();
  aiReviewedRowsRefresh=task;
  try{return await task;}finally{if(aiReviewedRowsRefresh===task) aiReviewedRowsRefresh=null;}
}

function isFullSessionReview() {
  return typeof isContinuousReview === 'function' && isContinuousReview();
}
function resetFullSessionReview(clearCheckpoint=false) {
  if(clearCheckpoint) {
    try { sessionStorage.removeItem(FULL_REVIEW_CHECKPOINT_KEY); } catch (_) {}
  }
  if(window.CollectorBackgroundLists && sessionReviewListEl) { window.CollectorBackgroundLists.clear(sessionReviewListEl);sessionReviewListEl.classList.remove("instant-list-host"); }
  fullSessionReviewGeneration++;
  fullSessionReview?.controller?.abort();
  if (fullSessionReview?.timer) clearTimeout(fullSessionReview.timer);
  fullSessionReview?.cards.forEach(entry=>entry.node.querySelector('img')?.removeAttribute('src'));
  fullSessionReview = null;
}
function fullReviewContextMatches(state) {
  return fullSessionReview === state && state.epoch === datasetEpoch && state.datasetId === activeDatasetId &&
    state.runId === reviewBatch?.batch_id && !datasetSwitching;
}
function fullReviewItems() { return fullSessionReview?.pages.flatMap(page => page.items) || []; }
function fullReviewItem(key) {
  return fullReviewItems().find(item => sampleKey(item) === key) || fullSessionReview?.selected.get(key);
}
function fullReviewSelection() { return fullSessionReview ? [...fullSessionReview.selected.values()] : []; }
function fullReviewQuery() {
  return {search:document.getElementById('review-search')?.value.trim() || '',filter:document.getElementById('review-filter')?.value || 'all'};
}
function renderFullSessionReview() {
  let query = fullReviewQuery();
  const previous = fullSessionReview;
  const contextChanged = !previous || previous.epoch !== datasetEpoch || previous.datasetId !== activeDatasetId || previous.runId !== reviewBatch?.batch_id;
  if (contextChanged || previous.search !== query.search || previous.filter !== query.filter) {
    const saved=contextChanged ? readFullReviewCheckpoint() : null;
    if(saved) {
      document.getElementById('review-search').value=saved.search;
      document.getElementById('review-filter').value=saved.filter;
      query={search:saved.search,filter:saved.filter};
    }
    resetFullSessionReview();
    const state = fullSessionReview = {epoch:datasetEpoch,datasetId:activeDatasetId,runId:reviewBatch?.batch_id,
      search:query.search,filter:query.filter,pages:[],cursors:[null],total:0,selected:new Map(),cards:new Map(),editing:null,drafts:new Map(),loading:false,error:'',ready:false,mutation:false};
    if(window.CollectorBackgroundLists) { state.ready=false; }
    else if(saved) {state.cursors=saved.cursors;void restoreFullReviewWindow(state,saved);}
    else if (contextChanged) void loadFullReviewPage(0);
    else state.timer = setTimeout(() => {state.timer=null;if(fullReviewContextMatches(state)) void loadFullReviewPage(0);},180);
  }
  paintFullSessionReview();
  const view = document.getElementById('main-content');
  if (view && !view.dataset.fullReviewScroll) {
    view.dataset.fullReviewScroll='true';
    view.addEventListener('scroll', () => {
      const state = fullSessionReview;
      if (currentView !== 'session-review' || !state || state.loading || state.restoring || state.mutation || state.editing || !state.pages.length) return;
      if (view.scrollHeight > view.clientHeight && view.scrollHeight-view.scrollTop-view.clientHeight<320) void loadFullReviewPage(state.pages.at(-1).index+1);
      else if (view.scrollTop<80 && state.pages[0].index>0) void loadFullReviewPage(state.pages[0].index-1);
    },{passive:true});
  }
}
async function loadFullReviewPage(index) {
  const state = fullSessionReview;
  if (!state || !fullReviewContextMatches(state) || state.loading || state.mutation || index<0) return;
  if (index>0 && !state.cursors[index]) return;
  if (state.pages.some(page=>page.index===index)) return;
  state.controller?.abort();state.controller=new AbortController();
  state.loading=true;state.error='';paintFullSessionReview();
  const generation=fullSessionReviewGeneration;
  const view=document.getElementById('main-content');
  const oldItems=fullReviewItems(), backwards=state.pages.length && index<state.pages[0].index;
  const anchorItem=backwards ? oldItems[0] : state.pages.length>=FULL_REVIEW_WINDOW_PAGES ? state.pages[1].items[0] : oldItems[0];
  const anchorKey=anchorItem && sampleKey(anchorItem);
  const anchorBefore=anchorKey && [...sessionReviewListEl.children].find(node=>node.dataset.reviewKey===anchorKey)?.getBoundingClientRect().top;
  try {
    const params=new URLSearchParams({run_id:state.runId,limit:String(FULL_REVIEW_PAGE_SIZE),search:state.search,filter:state.filter});
    if(state.cursors[index]) params.set('cursor',state.cursors[index]);
    const data=await (await datasetFetch('/api/queue/review/items?'+params,{datasetId:state.datasetId,signal:state.controller.signal})).json();
    if(!fullReviewContextMatches(state) || generation!==fullSessionReviewGeneration) return;
    const page={index,items:data.items || []};
    state.cursors[index+1]=data.next_cursor || null;
    state.pages.push(page);state.pages.sort((a,b)=>a.index-b.index);
    if(state.pages.length>FULL_REVIEW_WINDOW_PAGES) backwards ? state.pages.pop() : state.pages.shift();
    state.total=data.total || 0;state.ready=true;
    if(data.review_stats) streamStats=data.review_stats;
    if(data.summary) applyQueueSummary(data.summary);
    state.loading=false;paintFullSessionReview();
    const anchorAfter=anchorKey && [...sessionReviewListEl.children].find(node=>node.dataset.reviewKey===anchorKey)?.getBoundingClientRect().top;
    if(view && Number.isFinite(anchorBefore) && Number.isFinite(anchorAfter)) {
      view.scrollTop+=anchorAfter-anchorBefore;
      window.CollectorScroll?.adopt();
    }
  } catch(error) {
    if(fullReviewContextMatches(state) && error.name!=='AbortError') {state.error=error.message;state.retryIndex=index;state.loading=false;paintFullSessionReview();}
  } finally {if(fullReviewContextMatches(state)) state.loading=false;}
}
function paintFullSessionReview() {
  const state=fullSessionReview;if(!state || !fullReviewContextMatches(state)) return;
  document.getElementById('session-review-hud').classList.remove('hidden');
  document.querySelector('.review-page-bar')?.classList.toggle('hidden',!!window.CollectorBackgroundLists);document.querySelector('.review-page-footer')?.classList.toggle('hidden',!!window.CollectorBackgroundLists);
  document.getElementById('session-review-empty')?.classList.add('hidden');
  const existingInput=state.editing && document.getElementById('edit-input-full-review-'+fullReviewItem(state.editing)?.queue_id);
  if(existingInput) state.drafts.set(state.editing,existingInput.value);
  const items=fullReviewItems();
  updateReviewBulkUI();
  const keep=new Set(items.map(sampleKey)),nodes=[];
  for(const [key,entry] of state.cards) if(!keep.has(key)){entry.node.querySelector('img')?.removeAttribute('src');state.cards.delete(key);}
  const createReviewCard = item => {
    const key=sampleKey(item),reference='full-review-'+item.queue_id;
    const signature=JSON.stringify([item.label,item.reviewed,item.discarded,state.selected.has(key),state.editing===key,state.mutation]);
    if(!window.CollectorBackgroundLists && state.cards.get(key)?.signature===signature) return state.cards.get(key).node;
    state.cards.get(key)?.node.querySelector('img')?.removeAttribute('src');
    const card=renderCard({imageSrc:cropImage(item),label:item.label,id:item.id,originalIdx:reference,isSelected:state.selected.has(key),
      isIgnored:item.discarded,isBlank:item.reviewed && item.label==='' && !item.discarded,isEditing:state.editing===key,
      onToggle:()=>toggleFullReviewSelection(key),onEdit:()=>startFullSessionEdit(key),onSave:()=>saveFullSessionLabel(key),
      onRemove:()=>removeFullSessionItems([item]),removeLabel:'Remove',onKeydown:event=>{
        if(event.key==='Enter'){event.preventDefault();void saveFullSessionLabel(key);}
        else if(event.key==='Escape'){event.preventDefault();state.editing=null;state.drafts.delete(key);paintFullSessionReview();}
      }});
    card.dataset.reviewKey=key;
    const image=card.querySelector('img');if(image){image.loading='lazy';image.decoding='async';}
    const input=card.querySelector('input.card-label');
    if(input){if(state.drafts.has(key)) input.value=state.drafts.get(key);input.disabled=state.mutation;input.oninput=()=>state.drafts.set(key,input.value);}
    state.cards.set(key,{node:card,signature});return card;
  };
  if(window.CollectorBackgroundLists) {
    sessionReviewListEl.classList.add("instant-list-host");
    window.CollectorBackgroundLists.render(sessionReviewListEl,{path:"/api/queue/review/items",datasetId:state.datasetId,query:{run_id:state.runId,search:state.search,filter:state.filter},key:sampleKey,card:createReviewCard,dispose:(item,node)=>{const key=sampleKey(item);if(state.cards.get(key)?.node===node) state.cards.delete(key);},changed:(items,meta,loading,error)=>{
      if(!fullReviewContextMatches(state)) return;
      state.pages=[{index:0,items}];state.loading=loading;state.error=error ? "Could not load session crops" : "";state.ready=!loading || items.length>0;
      if(meta?.review_stats) streamStats=meta.review_stats;if(meta?.summary) applyQueueSummary(meta.summary);
      updateReviewSelectShown(items.slice(0,100),item=>state.selected.has(sampleKey(item)),state.mutation);
      updateReviewBulkUI();
    }});
    return;
  }
  for(const item of items) nodes.push(createReviewCard(item));
  // Keep retained cards attached: detaching the whole grid can clamp its parent's scroll.
  const retained=new Set(nodes);
  for(const node of [...sessionReviewListEl.children]) if(!retained.has(node)) node.remove();
  nodes.forEach((node,index)=>{
    if(sessionReviewListEl.children[index]!==node) sessionReviewListEl.insertBefore(node,sessionReviewListEl.children[index] || null);
  });
  if(!items.length) {
    const message=document.createElement('p');message.className='search-empty';message.setAttribute('role','status');
    message.textContent=state.error ? 'Could not load session crops. Use Retry below.' : !state.ready ? 'Loading session crops…' : 'No crops match this search and filter.';
    sessionReviewListEl.appendChild(message);
  }
  const first=state.pages[0]?.index || 0, start=items.length ? first*FULL_REVIEW_PAGE_SIZE+1 : 0;
  const status=document.getElementById('review-page-status');
  if(status) status.textContent=state.error || (!state.ready ? 'Loading session…' : `${start.toLocaleString()}–${(items.length?Math.min(state.total,start+items.length-1):0).toLocaleString()} of ${state.total.toLocaleString()} ${state.search || state.filter!=='all' ? 'matches' : 'crops'}`)+(state.loading && state.ready ? ' · Loading…' : '');
  const earlier=document.getElementById('review-page-earlier'),more=document.getElementById('review-page-more');
  if(earlier){earlier.classList.toggle('hidden',!state.pages.length || first===0);earlier.disabled=state.loading || state.mutation;earlier.onclick=()=>loadFullReviewPage(first-1);}
  const nextIndex=state.pages.length ? state.pages.at(-1).index+1 : 0;
  if(more){more.classList.toggle('hidden',!state.error && !state.cursors[nextIndex]);more.disabled=state.loading || state.mutation;more.textContent=state.error?'Retry':'More crops';more.onclick=()=>loadFullReviewPage(state.error?state.retryIndex || 0:nextIndex);}
  updateReviewSelectShown(items.slice(0,100),item=>state.selected.has(sampleKey(item)),state.mutation);
  const search=document.getElementById('review-search');if(search) search.placeholder='Search all session crops…';
  const commit=document.getElementById('btn-add-db');if(commit) commit.disabled=state.mutation || queueCommitBusy || reviewSaving || !!(typeof isAiReviewBusy==='function' && isAiReviewBusy());
  const options=document.getElementById('review-search-list');if(options) options.replaceChildren();
  updateReviewBulkUI();
  saveFullReviewCheckpoint(state);
}
function toggleFullReviewSelection(key) {
  const state=fullSessionReview,item=fullReviewItem(key);if(!state || state.mutation || !item) return;
  if(state.selected.has(key)) state.selected.delete(key);
  else {if(state.selected.size>=100){showToast('Select up to 100 crops at a time.','error');return;}state.selected.set(key,item);}
  paintFullSessionReview();
}
function updateReviewSelectShown(items,isSelected,disabled=false) {
  const button=document.getElementById('btn-review-select-all');if(!button) return;
  const selectedCount=items.filter(isSelected).length;
  const all=items.length>0 && selectedCount===items.length;
  button.classList.toggle('hidden',!items.length);
  button.setAttribute('aria-pressed',all?'true':selectedCount?'mixed':'false');
  button.textContent=all?'Deselect shown':'Select shown';
  button.title=button.textContent;button.setAttribute('aria-label',button.textContent);
  button.disabled=disabled;
}
function selectFullReviewShown() {
  const state=fullSessionReview;if(!state || state.mutation) return;
  const items=fullReviewItems().slice(0,100);
  if(items.length && items.every(item=>state.selected.has(sampleKey(item)))) {
    for(const item of items) state.selected.delete(sampleKey(item));
  } else {
    for(const item of items) {
      if(state.selected.has(sampleKey(item))) continue;
      if(state.selected.size>=100) {showToast('Select up to 100 crops at a time.','error');break;}
      state.selected.set(sampleKey(item),item);
    }
  }
  paintFullSessionReview();
}
function startFullSessionEdit(key) {
  const state=fullSessionReview,item=fullReviewItem(key);if(!state || state.mutation || !item) return;
  state.editing=key;updateEditDatalist(item);paintFullSessionReview();
  const input=document.getElementById('edit-input-full-review-'+item.queue_id);input?.focus({preventScroll:true});input?.select();
}
async function persistFullSessionEdit(state,item,label) {
  if(!fullReviewContextMatches(state) || queueCommitBusy) throw new Error('Session changed or is saving; edit cancelled.');
  const data=await (await datasetFetch('/api/review_label',{datasetId:state.datasetId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    sample_key:sampleKey(item),queue_id:item.queue_id,id:item.id,prediction_id:item.prediction_id || null,label,action:'correct',allow_outside_contract:!!SchemaRegistry.validateReviewed(item.id,label).outsideContract
  })})).json();
  if(!fullReviewContextMatches(state)) return;
  if(data.success===false || !data.event) throw new Error(data.error || 'Reviewed label was not saved');
  const oldLabel=item.label;item.label=label;item.reviewed=true;item.discarded=false;item.review_event=data.event;
  const buffered=pool.find(candidate=>sampleKey(candidate)===sampleKey(item));
  if(buffered){
    buffered.label=label;buffered.reviewed=true;buffered.discarded=false;
    const key=sampleKey(buffered),receipt=reviewAwards[key] || buffered.review_reward || {points:0,action:'correct',previouslyReviewed:true};
    reviewAwards[key]={...receipt,label};buffered.review_reward=reviewAwards[key];
  }
  syncPoolsWithLabelChange(oldLabel,label,item.id.includes('name')?'name':null);
  if(data.summary) applyQueueSummary(data.summary);
}
async function refreshFullReviewWindow(state) {
  if(!fullReviewContextMatches(state)) return;
  if(window.CollectorBackgroundLists) { state.editing=null;state.drafts.clear();state.selected.clear();await window.CollectorBackgroundLists.invalidate("/api/queue/review/items",state.datasetId);paintFullSessionReview();return; }
  // Fetch replacements while the existing window stays mounted, then swap atomically.
  const indexes=state.pages.length ? state.pages.map(page=>page.index) : [0];
  state.controller?.abort();state.controller=new AbortController();
  const controller=state.controller,generation=fullSessionReviewGeneration;
  state.loading=true;state.error='';paintFullSessionReview();
  const pages=[],cursors=[...state.cursors];let metadata;
  try {
    for(const index of indexes) {
      if(index>0 && !cursors[index]) break;
      const params=new URLSearchParams({run_id:state.runId,limit:String(FULL_REVIEW_PAGE_SIZE),search:state.search,filter:state.filter});
      if(cursors[index]) params.set('cursor',cursors[index]);
      metadata=await (await datasetFetch('/api/queue/review/items?'+params,{datasetId:state.datasetId,signal:controller.signal})).json();
      if(!fullReviewContextMatches(state) || generation!==fullSessionReviewGeneration || state.controller!==controller) return;
      pages.push({index,items:metadata.items || []});cursors[index+1]=metadata.next_cursor || null;
    }
    if(!fullReviewContextMatches(state) || state.controller!==controller) return;
    state.pages=pages;state.cursors=cursors;state.total=metadata?.total || 0;state.ready=true;
    state.editing=null;state.drafts.clear();state.selected.clear();state.loading=false;
    if(metadata?.review_stats) streamStats=metadata.review_stats;
    if(metadata?.summary) applyQueueSummary(metadata.summary);
    paintFullSessionReview();
  } finally {
    if(fullReviewContextMatches(state) && state.controller===controller) {state.loading=false;paintFullSessionReview();}
  }
}
async function saveFullSessionLabel(key) {
  const state=fullSessionReview,item=fullReviewItem(key);if(!state || state.mutation || queueCommitBusy || !item) return;
  const input=document.getElementById('edit-input-full-review-'+item.queue_id);if(!input) return;
  const label=input.value.trim();state.mutation=true;paintFullSessionReview();
  try{await persistFullSessionEdit(state,item,label);if(fullReviewContextMatches(state)){state.mutation=false;await refreshFullReviewWindow(state);await saveSessionProgress(true);updateStepperButtons();}}
  catch(error){if(fullReviewContextMatches(state)){state.mutation=false;showToast(error.message,'error');paintFullSessionReview();}}
}
async function bulkLabelFullSession() {
  const state=fullSessionReview,label=document.getElementById('review-bulk-label-input').value.trim();
  if(!state || state.mutation || queueCommitBusy || !label) return;
  const items=fullReviewSelection();if(!items.length || items.length>100) return;
  state.mutation=true;paintFullSessionReview();
  try{for(const item of items){await persistFullSessionEdit(state,item,label);if(!fullReviewContextMatches(state)) return;}
    state.mutation=false;document.getElementById('review-bulk-label-input').value='';await refreshFullReviewWindow(state);await saveSessionProgress(true);updateStepperButtons();showToast(`Applied label to ${items.length} crops`,'success');
  }catch(error){if(fullReviewContextMatches(state)){state.mutation=false;showToast(error.message,'error');paintFullSessionReview();}}
}
async function removeFullSessionItems(items=fullReviewSelection()) {
  const state=fullSessionReview;if(!state || state.mutation || queueCommitBusy || !items.length || items.length>100) return;
  if(!await showConfirmModal('Remove crops',`Remove ${items.length} selected crops from this session?`)) return;
  if(!fullReviewContextMatches(state)) return;
  state.mutation=true;paintFullSessionReview();
  try{const data=await (await datasetFetch('/api/queue/discard',{datasetId:state.datasetId,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sample_keys:items.map(sampleKey)})})).json();
    if(!fullReviewContextMatches(state)) return;
    const removed=new Set(items.map(sampleKey));pool=pool.filter(item=>!removed.has(sampleKey(item)));
    if(reviewBatch) reviewBatch={...reviewBatch,keys:pool.map(sampleKey)};
    currentReviewIdx=Math.min(currentReviewIdx,Math.max(0,pool.length-1));maxReachedIdx=Math.min(maxReachedIdx,Math.max(0,pool.length-1));
    if(data.summary) applyQueueSummary(data.summary);state.mutation=false;await refreshFullReviewWindow(state);await saveSessionProgress(true);updateStepperButtons();
  }catch(error){if(fullReviewContextMatches(state)){state.mutation=false;showToast(error.message,'error');paintFullSessionReview();}}
}
