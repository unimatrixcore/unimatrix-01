// Actual Review controls with synthetic jobs; no real crops, API keys or paid calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const ui=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(ui,'package.json'))('jsdom');
const dom=new JSDOM(fs.readFileSync('dev_tools/templates/poker_lab.html','utf8'),{url:'http://localhost/review',runScripts:'outside-only',pretendToBeVisual:true}),{window}=dom;
const calls=[],refreshes=[],holds=[];let holdStatus=false,failStatus=false,configured=false;
let job=null;
window.datasetFetch=async(url,options={})=>{
  const body=options.body&&JSON.parse(options.body);calls.push({url,body,options});let data;
  if(url==='/api/ai-review/config') {
    assert.equal(options.method,undefined,'review only reads global configuration');
    assert.equal(options.datasetId,undefined,'global settings do not carry a collection header');
    data={configured,model:'gpt-4.1'};
  } else if(url.startsWith('/api/ai-review/jobs?')) {
    if(holdStatus) data=await new Promise(resolve=>holds.push(resolve));
    else if(failStatus) throw new Error('Unexpected collector response (HTTP 404). Refresh and try again.');
    else data={job:job&&structuredClone(job)};
  } else if(url==='/api/ai-review/jobs' && options.method==='POST') {
    job={id:'job1',run_id:body.run_id,state:'running',total:120,checked:0,corrected:0,flagged:0,conflicts:0,batches:10,batch_index:0,region:'seats[*].bank',recent:[]};data={job:structuredClone(job)};
  } else if(url.endsWith('/cancel')) {job.state='cancelled';data={job:structuredClone(job)};}
  else if(url.endsWith('/resume')) {job.state='running';data={job:structuredClone(job)};}
  else throw new Error('Unexpected API '+url);
  return {ok:true,status:200,json:async()=>data};
};
window.fetch=window.datasetFetch;
window.refreshAiReviewedRows=async item=>{refreshes.push(item);return window.allowRefresh;};window.allowRefresh=true;
const context=dom.getInternalVMContext(),run=code=>vm.runInContext(code,context);
run(`let activeDatasetId='dataset-one',datasetEpoch=0,datasetSwitching=false,currentView='session-review';
let reviewBatch={mode:'stream',batch_id:'run-one'},queueCommitBusy=false,reviewSaving=false,fullSessionReview=null;
function isContinuousReview(){return reviewBatch?.mode==='stream';}`);
vm.runInContext(fs.readFileSync('dev_tools/static/js/lib/ai_review.js','utf8'),context);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0)),settle=async()=>{await tick();await tick();await tick();};
const el=id=>window.document.getElementById(id);
(async()=>{try{
  run('initAiReview()');await settle();
  assert.ok([...el('review-filter').options].some(option=>option.value==='ai_flagged'),'full-session filter can browse all AI flags');
  assert.ok([...el('review-filter').options].some(option=>option.value==='ai_corrected'),'full-session filter can browse all AI corrections');
  assert.equal(calls.filter(c=>c.url.startsWith('/api/ai-review/jobs?')).length,1,'opening Review discovers existing server job without starting one');
  assert.equal(el('btn-ai-review').classList.contains('hidden'),false);
  assert.equal(el('ai-review-start').disabled,true);
  assert.equal(el('ai-review-panel').querySelector('details'),null,'review controls and grid have no unnecessary disclosures');
  assert.equal(el('ai-review-panel').querySelector('.ai-review-disclosure'),null);
  assert.equal(el('ai-review-heading').parentElement.querySelector('p'),null);
  assert.equal(el('ai-review-key-note'),null);
  assert.equal(el('ai-review-api-key'),null,'review does not own a password field');
  assert.equal(el('ai-review-model'),null,'model configuration belongs to app settings');
  let openedSettings=0;window.addEventListener('poker-open-settings',()=>openedSettings++);
  el('btn-ai-review').click();assert.equal(el('btn-ai-review').getAttribute('aria-expanded'),'true');
  el('ai-review-open-settings').click();
  assert.equal(openedSettings,1);assert.equal(el('ai-review-panel').classList.contains('hidden'),true,'global settings hides the review panel');
  configured=true;window.dispatchEvent(new window.Event('poker-ai-settings-change'));await settle();
  assert.equal(el('ai-review-start').disabled,false,'saved global key enables review without re-entry');
  assert.equal(el('ai-review-open-settings').classList.contains('hidden'),true);
  el('btn-ai-review').click();
  el('ai-review-start').click();el('ai-review-start').click();await settle();
  assert.equal(calls.filter(c=>c.url==='/api/ai-review/jobs'&&c.options.method==='POST').length,1,'repeated start is bounded');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('poker-lab:ai-review-panel:v1')),{datasetId:'dataset-one',runId:'run-one',open:true});assert.equal(window.sessionStorage.length,0);
  assert.ok(Object.keys(window.localStorage).every(key=>key.includes(':ai-review-panel:')),'only nonsecret panel visibility is stored');
  assert.equal(calls.some(call=>call.body?.api_key),false,'review never sends or receives an API key');
  assert.equal(calls.find(c=>c.url==='/api/ai-review/jobs').body.batch_size,12);
  assert.equal(calls.find(c=>c.url==='/api/ai-review/jobs').body.auto_correct,true);
  assert.equal(run('isAiReviewBusy()'),true);assert.equal(el('btn-add-db').disabled,true);
  assert.equal(el('ai-review-start').disabled,true);
  assert.equal(el('ai-review-pause').classList.contains('hidden'),false);
  assert.match(el('ai-review-grid').getAttribute('src'),/job1\/grid\?batch=0&dataset_id=dataset-one/);
  job={...job,grid_batch_index:null,grid_region:null};await run('pollAiReview()');
  assert.equal(el('ai-review-grid').hasAttribute('src'),false,'pending grids do not request a missing PNG');
  assert.equal(el('ai-review-grid-details').classList.contains('hidden'),true);
  job={...job,batch_index:3,grid_batch_index:1,grid_region:'seats[*].name'};await run('pollAiReview()');
  assert.match(el('ai-review-grid').getAttribute('src'),/grid\?batch=1&dataset_id=dataset-one/,'preview uses latest stored grid rather than pending batch');
  assert.equal(el('ai-review-grid-caption').textContent,'seats[*].name · Batch 2 of 10');

  job={...job,checked:12,corrected:1,flagged:1,recent:[{sample_key:'one',state:'corrected',region_id:'seats[0].bank',prior_label:'S 5 BB',label:'S 6 BB'},{sample_key:'two',state:'flagged',region_id:'seats[1].bank',prior_label:'<img src=x onerror=alert(1)>',reason:'Unclear crop'}]};
  await run('pollAiReview()');assert.equal(el('ai-review-counts').textContent,'12 / 120');assert.equal(el('ai-review-corrected').textContent,'1');
  assert.equal(el('ai-review-changes').querySelector('img'),null,'untrusted label text cannot create markup');
  assert.match(el('ai-review-changes').textContent,/<img src=x/);
  assert.equal(refreshes.at(-1).checked,12,'parent is told to refresh durable crop labels');
  const refreshCount=refreshes.length;await run('pollAiReview()');assert.equal(refreshes.length,refreshCount,'unchanged progress does not repaint review cards');

  el('ai-review-pause').click();await settle();assert.equal(run('isAiReviewBusy()'),false);
  assert.equal(el('ai-review-resume').classList.contains('hidden'),false);assert.equal(el('btn-add-db').disabled,false);
  el('ai-review-resume').click();await settle();assert.equal(run('isAiReviewBusy()'),true);
  assert.equal(calls.filter(c=>c.url.endsWith('/resume')).length,1);

  failStatus=true;await run('pollAiReview()');assert.match(el('ai-review-error').textContent,/HTTP 404/);
  assert.equal(el('ai-review-retry').classList.contains('hidden'),false);failStatus=false;el('ai-review-retry').click();await settle();
  assert.equal(el('ai-review-error').classList.contains('hidden'),true);

  window.allowRefresh=false;job={...job,state:'completed',checked:120,corrected:2};await run('pollAiReview()');
  assert.equal(run('aiReviewState.refreshDeferred'),true);assert.ok(run('aiReviewState.timer'),'deferred final refresh keeps retrying while manual editing');
  window.allowRefresh=true;await run('pollAiReview()');assert.equal(run('aiReviewState.refreshDeferred'),false);
  assert.equal(run('aiReviewState.timer'),null,'finished jobs do not keep polling once synchronized');
  const startedBeforeRestore=calls.filter(call=>call.url==='/api/ai-review/jobs'&&call.options.method==='POST').length;
  const resumedBeforeRestore=calls.filter(call=>call.url.endsWith('/resume')).length;
  run('resetAiReview();syncAiReviewView();');await settle();
  assert.equal(el('ai-review-panel').classList.contains('hidden'),false,'panel visibility survives a fresh controller session');
  assert.equal(run('aiReviewState.job.id'),'job1','the same durable job is discovered without starting or resuming provider work');
  assert.equal(calls.filter(call=>call.url==='/api/ai-review/jobs'&&call.options.method==='POST').length,startedBeforeRestore);
  assert.equal(calls.filter(call=>call.url.endsWith('/resume')).length,resumedBeforeRestore);
  el('ai-review-close').click();run('resetAiReview();syncAiReviewView();');await settle();
  assert.equal(el('ai-review-panel').classList.contains('hidden'),true,'an explicitly closed panel stays closed');
  el('btn-ai-review').click();

  run("currentView='labeling';syncAiReviewView();");assert.equal(el('ai-review-grid').hasAttribute('src'),false);
  assert.equal(run('aiReviewState.timer'),null);
  run("currentView='session-review';syncAiReviewView();");await settle();
  Object.defineProperty(window.document,'hidden',{configurable:true,value:true});window.document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(run('aiReviewState.timer'),null,'hidden tabs stop polling');
  Object.defineProperty(window.document,'hidden',{configurable:true,value:false});window.document.dispatchEvent(new window.Event('visibilitychange'));await settle();

  holdStatus=true;const held=run('pollAiReview()');await tick();assert.equal(holds.length,1);
  const oldSignal=calls.at(-1).options.signal;
  run("datasetEpoch++;activeDatasetId='dataset-two';reviewBatch={mode:'stream',batch_id:'run-two'};resetAiReview();syncAiReviewView();");await tick();
  assert.equal(oldSignal.aborted,true);holds[0]({job:{...job,run_id:'run-one'}});await held;
  assert.equal(run('aiReviewState.datasetId'),'dataset-two');assert.equal(run('aiReviewState.job'),null,'late old dataset status cannot leak into the new session');
  holdStatus=false;job=null;for(const resolve of holds.slice(1)) resolve({job:null});await settle();
  assert.ok(calls.filter(call=>call.url!=='/api/ai-review/config').every(call=>call.options.datasetId==='dataset-one'||call.options.datasetId==='dataset-two'));
  assert.equal(calls.some(call=>call.url.includes('/commit')),false,'AI controls never implicitly commit a collection');
  console.log('PASS: scoped AI review configuration, secret handling, start/pause/resume, progress/grid, safe result text, deferred refresh, error retry and stale-response isolation.');
}finally{run('resetAiReview()');window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
