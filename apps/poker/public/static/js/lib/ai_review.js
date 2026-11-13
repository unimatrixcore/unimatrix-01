// Dataset-bound OpenAI jobs review the durable session, never the browser's card window.
let aiReviewState = null, aiReviewGeneration = 0, aiReviewInitialized = false;
const AI_REVIEW_ACTIVE = new Set(['queued','running','checking','verifying','cancelling','starting']);
const AI_REVIEW_RESUMABLE = new Set(['cancelled','paused','interrupted','error','failed']);
const aiReviewElement = id => document.getElementById(id);

function aiReviewContext() {
  return typeof isContinuousReview === 'function' && isContinuousReview() &&
    typeof activeDatasetId !== 'undefined' && activeDatasetId && reviewBatch?.batch_id && !datasetSwitching;
}
function aiReviewMatches(state) {
  return aiReviewState === state && state.generation === aiReviewGeneration &&
    state.datasetId === activeDatasetId && state.epoch === datasetEpoch && state.runId === reviewBatch?.batch_id && !datasetSwitching;
}
function isAiReviewBusy() {
  const state = aiReviewState;
  return !!(state && aiReviewMatches(state) && (state.pending || state.statusLoading || AI_REVIEW_ACTIVE.has(state.job?.state)));
}
function clearAiReviewTimer(state) {
  if (state?.timer) clearTimeout(state.timer);
  if (state) state.timer = null;
}
function resetAiReview() {
  aiReviewGeneration++;
  clearAiReviewTimer(aiReviewState);
  aiReviewState?.controller.abort();
  aiReviewState = null;
  const key = aiReviewElement('ai-review-api-key'); if (key) key.value = '';
  aiReviewElement('ai-review-grid')?.removeAttribute('src');
  aiReviewElement('ai-review-panel')?.classList.add('hidden');
  aiReviewElement('btn-ai-review')?.setAttribute('aria-expanded','false');
  aiReviewElement('ai-review-button-progress')?.classList.add('hidden');
}
async function aiReviewRequest(state,path,options={}) {
  if (!aiReviewMatches(state)) throw new Error('Review session changed.');
  const response = await datasetFetch(path,{...options,datasetId:state.datasetId,signal:state.controller.signal});
  const data = await response.json();
  if (!aiReviewMatches(state)) throw new Error('Review session changed.');
  if (data.success === false) throw new Error(data.error || 'AI review request failed.');
  return data;
}
function aiReviewPost(state,path,body={}) {
  return aiReviewRequest(state,path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function aiReviewVisible(state) {
  return aiReviewMatches(state) && currentView === 'session-review' && !document.hidden;
}
function scheduleAiReviewPoll(state) {
  clearAiReviewTimer(state);
  if (!aiReviewVisible(state) || (!AI_REVIEW_ACTIVE.has(state.job?.state) && !state.refreshDeferred)) return;
  state.timer = setTimeout(() => {state.timer=null;void pollAiReview(state);},1500);
}
async function loadAiReviewConfig(state) {
  try {
    const config = await aiReviewRequest(state,'/api/ai-review/config');
    state.config = config;state.configError='';
    const model = aiReviewElement('ai-review-model');
    if (!state.modelEdited && config.model) model.value = config.model;
    paintAiReview();
  } catch (error) {
    if (aiReviewMatches(state) && error.name !== 'AbortError') {state.configError=error.message;paintAiReview();}
  }
}
async function applyAiReviewJob(state,job) {
  if (!aiReviewMatches(state)) return;
  if (job && job.run_id !== state.runId) throw new Error('AI review belongs to another session.');
  const previous = state.job;
  state.job = job;
  const signature = job && JSON.stringify([job.id,job.checked,job.corrected,job.flagged,job.conflicts,job.state]);
  paintAiReview();
  if (signature && signature !== state.refreshSignature && (job.checked > 0 || previous?.id === job.id)) {
    if (!aiReviewVisible(state)) {state.refreshDeferred=true;return;}
    if(Number(job.corrected)>Number(previous?.corrected || 0) && window.CollectorBackgroundLists) await window.CollectorBackgroundLists.invalidate("/api/label_history",state.datasetId);
    const refreshed = typeof refreshAiReviewedRows === 'function' ? await refreshAiReviewedRows(job) : true;
    if (!aiReviewMatches(state)) return;
    state.refreshDeferred = refreshed === false;
    if (!state.refreshDeferred) state.refreshSignature = signature;
  }
}
async function pollAiReview(state=aiReviewState) {
  if (!state || !aiReviewVisible(state) || state.statusLoading || state.pending) return;
  state.statusLoading=true;paintAiReview();
  try {
    const data = await aiReviewRequest(state,'/api/ai-review/jobs?'+new URLSearchParams({run_id:state.runId}));
    state.error='';await applyAiReviewJob(state,data.job || null);
  } catch(error) {
    if (aiReviewMatches(state) && error.name !== 'AbortError') state.error=error.message;
  } finally {
    if (aiReviewMatches(state)) {state.statusLoading=false;paintAiReview();scheduleAiReviewPoll(state);}
  }
}
function syncAiReviewView() {
  const button = aiReviewElement('btn-ai-review'); if (!button) return;
  if (!aiReviewContext()) {resetAiReview();button.classList.add('hidden');return;}
  button.classList.remove('hidden');
  let state = aiReviewState;
  if (!state || !aiReviewMatches(state)) {
    resetAiReview();
    state = aiReviewState = {generation:aiReviewGeneration,datasetId:activeDatasetId,epoch:datasetEpoch,runId:reviewBatch.batch_id,
      controller:new AbortController(),config:null,job:null,pending:false,statusLoading:false,error:'',timer:null,visible:false,modelEdited:false,refreshSignature:null,gridUrl:null};
    void loadAiReviewConfig(state);
  }
  const visible = currentView === 'session-review' && !document.hidden;
  if (!visible) {
    state.visible=false;clearAiReviewTimer(state);aiReviewElement('ai-review-api-key').value='';
    aiReviewElement('ai-review-grid')?.removeAttribute('src');state.gridUrl=null;
  } else if (!state.visible) {state.visible=true;void pollAiReview(state);}
  paintAiReview();
}
async function saveAiReviewSettings(state=aiReviewState,fromStart=false) {
  if (!state || !aiReviewMatches(state)) return false;
  const keyInput = aiReviewElement('ai-review-api-key');
  const apiKey = keyInput.value.trim();keyInput.value='';
  const model = aiReviewElement('ai-review-model').value.trim();
  if (!model) throw new Error('Enter an OpenAI model.');
  const payload = {model}; if (apiKey) payload.api_key=apiKey;
  const data = await aiReviewPost(state,'/api/ai-review/config',payload);
  state.config = data;state.configError='';state.modelEdited=false;
  if (!data.configured) {
    aiReviewElement('ai-review-settings').open=true;
    if (fromStart) throw new Error('Add an OpenAI API key in settings to start.');
  } else aiReviewElement('ai-review-settings').open=false;
  return !!data.configured;
}
async function runAiReviewAction(action) {
  const state=aiReviewState;
  if (!state || !aiReviewMatches(state) || state.pending || state.statusLoading) return;
  if ((action==='start' || action==='settings') && AI_REVIEW_ACTIVE.has(state.job?.state)) return;
  state.pending=true;state.error='';clearAiReviewTimer(state);paintAiReview();
  try {
    if (action==='settings') await saveAiReviewSettings(state);
    else if (action==='start') {
      const batchSize=Number(aiReviewElement('ai-review-batch-size').value);
      if (!Number.isInteger(batchSize) || batchSize<1 || batchSize>24) throw new Error('Use 1–24 crops per grid.');
      if (!await saveAiReviewSettings(state,true)) return;
      const data=await aiReviewPost(state,'/api/ai-review/jobs',{run_id:state.runId,model:aiReviewElement('ai-review-model').value.trim(),batch_size:batchSize,auto_correct:aiReviewElement('ai-review-auto-correct').checked});
      await applyAiReviewJob(state,data.job);
    } else if (state.job && (action==='cancel' || action==='resume')) {
      const data=await aiReviewPost(state,`/api/ai-review/jobs/${encodeURIComponent(state.job.id)}/${action}`);
      await applyAiReviewJob(state,data.job);
    }
  } catch (error) {
    if (aiReviewMatches(state) && error.name!=='AbortError') state.error=error.message;
  } finally {
    if (aiReviewMatches(state)) {state.pending=false;paintAiReview();scheduleAiReviewPoll(state);}
  }
}
function paintAiReview() {
  const state=aiReviewState;if(!state || !aiReviewMatches(state)) return;
  const job=state.job,active=AI_REVIEW_ACTIVE.has(job?.state),busy=state.pending || state.statusLoading;
  const count = value => Math.max(0,Number(value)||0).toLocaleString();
  aiReviewElement('ai-review-connection').textContent=state.config ? state.config.configured?'Key configured':'API key needed' : 'Checking connection…';
  aiReviewElement('ai-review-start').disabled=busy || active || !state.config || (!state.config.configured && !aiReviewElement('ai-review-api-key').value.trim());
  aiReviewElement('ai-review-start').textContent=state.pending && !job?'Starting…':job && !active?'Review again':'Start review';
  aiReviewElement('ai-review-save-settings').disabled=busy || active;
  ['ai-review-api-key','ai-review-model','ai-review-batch-size','ai-review-auto-correct'].forEach(id=>{aiReviewElement(id).disabled=busy || active;});
  const pause=aiReviewElement('ai-review-pause');pause.classList.toggle('hidden',!active);pause.disabled=busy || job?.state==='cancelling';pause.textContent=job?.state==='cancelling'?'Pausing…':'Pause';
  const resume=aiReviewElement('ai-review-resume');resume.classList.toggle('hidden',!AI_REVIEW_RESUMABLE.has(job?.state));resume.disabled=busy;
  const error=state.error || state.configError || job?.error || '';
  aiReviewElement('ai-review-error').textContent=error;aiReviewElement('ai-review-error').classList.toggle('hidden',!error);
  aiReviewElement('ai-review-retry').classList.toggle('hidden',!state.error && !state.configError);aiReviewElement('ai-review-retry').disabled=busy;
  aiReviewElement('ai-review-job').classList.toggle('hidden',!job);
  const badge=aiReviewElement('ai-review-button-progress');badge.classList.toggle('hidden',!job);
  if(job) {
    const label={queued:'Queued',running:'Checking crops',checking:'Checking crops',verifying:'Verifying corrections',cancelling:'Pausing',cancelled:'Paused',paused:'Paused',interrupted:'Paused after restart',error:'Review stopped',failed:'Review stopped',completed:'Review complete',complete:'Review complete'}[job.state] || job.state;
    aiReviewElement('ai-review-status').textContent=label;
    aiReviewElement('ai-review-counts').textContent=`${count(job.checked)} / ${count(job.total)}`;
    const progress=aiReviewElement('ai-review-progress');progress.max=Math.max(1,Number(job.total)||0);progress.value=Math.min(progress.max,Number(job.checked)||0);
    aiReviewElement('ai-review-corrected').textContent=count(job.corrected);
    aiReviewElement('ai-review-flagged').textContent=count((Number(job.flagged)||0)+(Number(job.conflicts)||0));
    aiReviewElement('ai-review-region').textContent=job.region || '';
    badge.textContent=active?`${count(job.checked)}/${count(job.total)}`:label;
    const gridDetails=aiReviewElement('ai-review-grid-details');
    const gridBatch=Object.prototype.hasOwnProperty.call(job,'grid_batch_index') ? job.grid_batch_index : job.batch_index;
    const gridRegion=job.grid_region || job.region || 'Region';
    const hasGrid=Number.isInteger(gridBatch) && gridBatch>=0 && Number(job.batches)>0;
    gridDetails.classList.toggle('hidden',!hasGrid);
    if(hasGrid) {
      aiReviewElement('ai-review-grid-caption').textContent=`${gridRegion} · Batch ${gridBatch+1} of ${job.batches} · Crop above, current label below.`;
      const url=`/api/ai-review/jobs/${encodeURIComponent(job.id)}/grid?`+new URLSearchParams({batch:String(gridBatch),dataset_id:state.datasetId});
      if(gridDetails.open && aiReviewVisible(state) && state.gridUrl!==url) {aiReviewElement('ai-review-grid').src=url;state.gridUrl=url;}
    } else {aiReviewElement('ai-review-grid').removeAttribute('src');state.gridUrl=null;}
    const list=aiReviewElement('ai-review-changes'),fragment=document.createDocumentFragment();
    const recent=(job.recent || job.changes || []).filter(item=>item.state!=='unchanged').slice(-12).reverse();
    const renderChange=item=>{
      const row=document.createElement('li');row.dataset.state=item.state || '';
      const region=document.createElement('span');region.className='ai-change-region';region.textContent=item.region_id || item.id || '';region.title=region.textContent;
      const labels=document.createElement('span');labels.className='ai-change-labels';
      if(item.state==='corrected') {
        const previous=document.createElement('del');previous.textContent=item.prior_label===''?'∅':item.prior_label ?? '';
        const arrow=document.createElement('span');arrow.className='ai-change-arrow';arrow.textContent='→';
        const next=document.createElement('span');next.textContent=item.label===''?'∅':item.label ?? '';
        labels.append(previous,arrow,next);
      } else labels.textContent=item.prior_label===''?'∅':item.prior_label ?? item.label ?? '';
      const outcome=document.createElement('span');outcome.className='ai-change-state';outcome.textContent=item.state==='conflict'?'Changed elsewhere':item.state==='corrected'?'Corrected':'Needs a look';
      if(item.reason) outcome.title=item.reason;
      row.append(region,labels,outcome);return row;
    };
    if(window.CollectorBackgroundLists) window.CollectorBackgroundLists.snapshot(list,{items:recent.map((item,index)=>({id:String(index),item})),key:row=>row.id,card:row=>renderChange(row.item),height:200,rowHeight:42,minColumnWidth:1000});
    else {for(const item of recent) fragment.appendChild(renderChange(item));list.replaceChildren(fragment);}
  }
  const commit=aiReviewElement('btn-add-db');
  if(commit) commit.disabled=isAiReviewBusy() || !!(typeof queueCommitBusy!=='undefined' && queueCommitBusy) || !!(typeof reviewSaving!=='undefined' && reviewSaving) || !!(typeof fullSessionReview!=='undefined' && fullSessionReview?.mutation);
}
function initAiReview() {
  if(aiReviewInitialized || !aiReviewElement('btn-ai-review')) return;
  aiReviewInitialized=true;
  const sharedBot=document.querySelector('#model-review svg');
  if(sharedBot) aiReviewElement('btn-ai-review').querySelector('[data-ai-review-icon]').appendChild(sharedBot.cloneNode(true));
  aiReviewElement('btn-ai-review').onclick=()=>{
    const panel=aiReviewElement('ai-review-panel'),opening=panel.classList.contains('hidden');
    panel.classList.toggle('hidden',!opening);aiReviewElement('btn-ai-review').setAttribute('aria-expanded',String(opening));
    if(opening){if(aiReviewState && !aiReviewState.config?.configured) aiReviewElement('ai-review-settings').open=true;syncAiReviewView();}
    else aiReviewElement('ai-review-api-key').value='';
  };
  aiReviewElement('ai-review-close').onclick=()=>{aiReviewElement('ai-review-panel').classList.add('hidden');aiReviewElement('btn-ai-review').setAttribute('aria-expanded','false');aiReviewElement('ai-review-api-key').value='';};
  aiReviewElement('ai-review-save-settings').onclick=()=>void runAiReviewAction('settings');
  aiReviewElement('ai-review-start').onclick=()=>void runAiReviewAction('start');
  aiReviewElement('ai-review-pause').onclick=()=>void runAiReviewAction('cancel');
  aiReviewElement('ai-review-resume').onclick=()=>void runAiReviewAction('resume');
  aiReviewElement('ai-review-retry').onclick=()=>{const state=aiReviewState;if(state){void loadAiReviewConfig(state);void pollAiReview(state);}};
  aiReviewElement('ai-review-api-key').oninput=()=>paintAiReview();
  aiReviewElement('ai-review-model').oninput=()=>{if(aiReviewState) aiReviewState.modelEdited=true;};
  aiReviewElement('ai-review-grid-details').addEventListener('toggle',()=>{
    if(!aiReviewElement('ai-review-grid-details').open){aiReviewElement('ai-review-grid').removeAttribute('src');if(aiReviewState) aiReviewState.gridUrl=null;}
    else paintAiReview();
  });
  document.addEventListener('visibilitychange',syncAiReviewView);
  window.addEventListener('pagehide',()=>{clearAiReviewTimer(aiReviewState);aiReviewElement('ai-review-api-key').value='';});
  syncAiReviewView();
}
