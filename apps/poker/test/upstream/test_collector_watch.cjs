// Fake clocks and deferred network; no browser, capture process, or source corpus.
const assert = require('node:assert/strict');
// Compare DOM identities as booleans: failed assertions must not inspect the
// cyclic JSDOM/React graph, which can exhaust the entire provider process scope.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const ts = require('typescript');
const watchSource = fs.readFileSync(path.join(__dirname,'../static/js/lib/watch_capture.js'),'utf8');
const appSource = fs.readFileSync(path.join(__dirname,'../static/js/app.js'),'utf8').replace('init().catch(error => { showLoading(false); showToast(error.message, "error"); });','').replace('const setView =','let setView =');
const flush = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
class FakeClock {
  constructor(){this.time=0;this.sequence=0;this.timers=new Map();}
  schedule(callback,delay){const id=++this.sequence;this.timers.set(id,{at:this.time+delay,callback});return id;}
  cancel(id){this.timers.delete(id);}
  async advance(ms){const target=this.time+ms;for(;;){const due=[...this.timers].filter(([,timer])=>timer.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;this.time=due[1].at;this.timers.delete(due[0]);due[1].callback();await flush();}this.time=target;await flush();}
}
const config={intervalSeconds:1,maxNewPerMinute:10,queueLimit:100};
function fixture(overrides={}) {
  const clock=new FakeClock(), statuses=[],calls={open:0,scan:0,close:0,batch:0};
  const state={view:'collection',hidden:false,dataset:'a',epoch:0};
  const window={};vm.runInNewContext(watchSource,{window,Date});
  const controller=window.CollectorWatchCapture.create({
    now:()=>clock.time,schedule:(fn,delay)=>clock.schedule(fn,delay),cancel:id=>clock.cancel(id),
    getContext:()=>({dataset:state.dataset,epoch:state.epoch}),canRun:ctx=>state.view==='collection'&&ctx.dataset===state.dataset&&ctx.epoch===state.epoch,
    queuedCount:()=>0,onStatus:value=>statuses.push(value),
    open:async()=>{calls.open++;return {lease_id:`lease-${calls.open}`};},
    scan:async()=>{calls.scan++;return {frames:[],added_count:0,queued_count:0,status:'duplicate'};},
    close:async()=>{calls.close++;},onBatch:async()=>{calls.batch++;},...overrides,
  });
  return {clock,state,calls,statuses,controller};
}
async function controllerTests(){
  const pending=deferred();let scans=0;
  const f=fixture({scan:async()=>{scans++;return pending.promise;}});
  assert.equal(f.controller.isActive(),false);assert.equal(f.clock.timers.size,0);assert.equal(f.calls.open,0,'construct/reload never starts capture');
  const first=f.controller.start(config);await flush();assert.equal(scans,1);
  await f.clock.advance(30000);assert.equal(scans,1,'one request stays in flight until completion');assert.equal(f.clock.timers.size,0);
  await f.controller.stop('Stopped');pending.resolve({frames:[{}],added_count:1,queued_count:1,status:'added'});await first;
  assert.equal(f.calls.batch,0,'stopped in-flight results never merge');assert.equal(f.clock.timers.size,0);assert.equal(f.controller.isActive(),false);

  const open=deferred();let closes=0;
  const opening=fixture({open:()=>open.promise,close:async()=>{closes++;}});
  const start=opening.controller.start(config);await flush();opening.controller.stop('Closed');open.resolve({lease_id:'late-lease'});await start;
  assert.equal(closes,1,'late start lease is explicitly revoked');assert.equal(opening.calls.scan,0);

  let admitted=0, networkScans=0;
  const continuous=fixture({scan:async()=>{networkScans++;admitted+=5;return {frames:[{}],added_count:5,queued_count:admitted,status:'added'};}});
  await continuous.controller.start(config);await continuous.clock.advance(5000);
  assert.equal(networkScans,6,'recording continues beyond the former minute cap');
  assert.equal(admitted,30);await continuous.controller.stop();

  const full=fixture({queuedCount:()=>95,scan:async()=>({frames:[{}],added_count:5,queued_count:100,status:'queue_full'})});
  await full.controller.start(config);assert.equal(full.controller.isActive(),false);assert.equal(full.clock.timers.size,0);assert.equal(full.calls.batch,1);assert.equal(full.controller.getState().message,'Queue full');
  const over=fixture({scan:async()=>({frames:[{}],added_count:6,queued_count:6,status:'added'})});
  await over.controller.start(config);assert.equal(over.calls.batch,0);assert.equal(over.controller.getState().status,'error');assert.equal(over.clock.timers.size,0,'invalid admission stops safely');
  const failure=fixture({scan:async()=>{throw new Error('Model unavailable');}});await failure.controller.start(config);assert.equal(failure.controller.isActive(),false);assert.match(failure.controller.getState().message,/Model unavailable/);

  for(const change of ['navigation','dataset']){
    const response=deferred();const c=fixture({scan:()=>response.promise});const starting=c.controller.start(config);await flush();
    if(change==='navigation')c.state.view='labeling';if(change==='hidden')c.state.hidden=true;if(change==='dataset'){c.state.dataset='b';c.state.epoch++;}
    response.resolve({frames:[{}],added_count:1,queued_count:1,status:'added'});await starting;
    assert.equal(c.calls.batch,0,`${change} rejects stale capture`);assert.equal(c.controller.isActive(),false);assert.equal(c.clock.timers.size,0);
  }

  const claim=deferred(), durable=[{id:'protected'}];let merged=0;
  const duringClaim=fixture({scan:async()=>({frames:durable,added_count:1,queued_count:1,status:'added'}),onBatch:async(_r,_ctx,isCurrent)=>{await claim.promise;if(isCurrent())merged++;}});
  const started=duringClaim.controller.start(config);await flush();await duringClaim.controller.stop();claim.resolve();await started;
  assert.equal(merged,0,'stop during durable claim cannot apply a late result');assert.equal(durable.length,1,'claim is non-destructive; reload still has the queue');

  const animation=deferred();let animationScans=0;
  const animated=fixture({scan:async()=>{animationScans++;return {frames:[{}],added_count:1,queued_count:1,status:'added'};},onBatch:()=>animation.promise});
  const animating=animated.controller.start(config);await flush();await animated.clock.advance(15000);assert.equal(animationScans,1,'capture waits for overlay cleanup/paint completion');
  await animated.controller.stop();animation.resolve();await animating;assert.equal(animated.clock.timers.size,0);


}
function appFixture(){
  const clock=new FakeClock(),elements=new Map(),listeners=new Map(),storage=new Map(),apiCalls=[],saves=[];
  const uiRoot=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
  const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(uiRoot,'src/lib/gamification.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports});
  function element(id=''){if(!elements.has(id)){const classes=new Set();elements.set(id,{id,value:'',style:{},textContent:'',disabled:false,dataset:{},children:[],classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle:(x,on)=>on?classes.add(x):classes.delete(x),replace(){},contains:x=>classes.has(x)},setAttribute(){},getAttribute(){return null;},focus(){},blur(){},select(){},replaceChildren(...items){this.children=items;},appendChild(item){this.children.push(item);},append(...items){this.children.push(...items);},matches(){return true;},setSelectionRange(){},dispatchEvent(){}});}return elements.get(id);}
  const tick=deferred();let durable=[];
  class ClockDate extends Date{static now(){return clock.time;}}
  const sandbox={console,Date:ClockDate,Promise,Headers,URLSearchParams,Event,setTimeout:(fn,delay)=>clock.schedule(fn,delay),clearTimeout:id=>clock.cancel(id),setInterval(){},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},sessionStorage:{getItem(){return null;},removeItem(){}},
    document:{hidden:false,getElementById:element,createElement:()=>element(`new-${Math.random()}`),addEventListener:(name,fn)=>listeners.set(name,fn),querySelectorAll:()=>[]},
    window:{CollectorSharedUi:{reviewGamification:module.exports},setTimeout:(fn,delay)=>clock.schedule(fn,delay),clearTimeout:id=>clock.cancel(id),addEventListener:(name,fn)=>listeners.set(name,fn),location:{pathname:'/collection'},matchMedia:()=>({matches:true}),
      fetch:async(url,options)=>{apiCalls.push({url,body:options.body&&JSON.parse(options.body),dataset:options.headers.get('X-Dataset-ID')});let data;
        if(url==='/api/watch/start')data={lease_id:'watch-lease'};
        else if(url==='/api/watch/tick')data=await tick.promise;
        else if(url==='/api/watch/claim')data={frames:durable,queued_count:durable.reduce((sum,f)=>sum+f.regions.length,0)};
        else if(url==='/api/watch/stop')data={success:true};
        else throw Error(`Unexpected route ${url}`);
        return {ok:true,status:200,json:async()=>data};}},history:{pushState(){},replaceState(){}},showToast(){}};
  vm.createContext(sandbox);vm.runInContext(watchSource,sandbox);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),sandbox);vm.runInContext(appSource,sandbox);
  const run=code=>vm.runInContext(code,sandbox);
  sandbox.saveSnapshots=saves;
  run(`activeDatasetId='a';isRecovering=false;currentView='collection';labelingUnlocked=false;reviewUnlocked=false;
    monitorSelect=document.getElementById('monitor-select');monitorSelect.value='monitor-1';
    for(const [id,value] of [['watch-interval','2'],['watch-rate','20'],['watch-queue','200']])document.getElementById(id).value=value;
    frameListEl=document.getElementById('frame-list');viewCollection=document.getElementById('view-collection');viewLabeling=document.getElementById('view-labeling');viewSessionReview=document.getElementById('view-session-review');viewDatabase=document.getElementById('view-database');viewLabelingStats=document.getElementById('labeling-stats-card');
    labelInput=document.getElementById('label-input');labelInput.value='unsaved draft';
    pool=[{id:'seat.name',sample_key:'recovered',phash:'old',label:'CorrectName',reviewed:true}];frames=[];reviewAwards={recovered:{points:20}};
    renderFrames=()=>{};renderReview=()=>{globalThis.renderedReview=true};updateStepperButtons=()=>{};renderDatasetNavigator=()=>{};showLoading=()=>{};loadDatabase=()=>{};
    saveSessionProgress=async()=>saveSnapshots.push(JSON.stringify({frames,pool,reviewAwards,draft:labelInput.value}));
    initCaptureWatch();`);
  return {sandbox,run,clock,apiCalls,saves,elements,listeners,resolveTick:frame=>{durable=[frame];tick.resolve({frames:[frame],added_count:frame.regions.length,queued_count:frame.regions.length,status:'added'});},tick};
}
async function appTests(){
  const a=appFixture();assert.equal(a.apiCalls.length,0,'app initialization does not resume watch');
  const started=a.run(`captureWatch.start({intervalSeconds:2,maxNewPerMinute:20,queueLimit:200})`);await flush();
  await a.elements.get('capture-once').onclick();assert.equal(a.apiCalls.filter(c=>c.url==='/api/capture').length,0,'Capture button cannot overlap watch');
  a.run('watchNeedsRecovery=true');
  const start=appSource.indexOf('  const btnLabelRegions = document.getElementById("btn-label-regions");');
  const end=appSource.indexOf('  const btnStatsReview',start);
  vm.runInContext(appSource.slice(start,end),a.sandbox);
  const label=a.elements.get('btn-label-regions').onclick();await flush();assert.equal(a.run('currentView'),'collection','Label regions waits for admitted work instead of racing processPool');
  const frame={id:'watch-frame',source:'capture.png',game_id:'123',watch:true,frame_width:1000,frame_height:800,regions:[{id:'seat.status',sample_key:'fresh',phash:'new',base64_image:'png',rect:{x:20,y:30,w:80,h:20},label:'model guess'}]};
  a.resolveTick(frame);await started;await label;
  assert.equal(a.run('currentView'),'labeling');assert.equal(a.run('pool.length'),2);
  assert.equal(a.run(`pool.find(item=>item.sample_key==='recovered').label`),'CorrectName','recovered pool-only labels survive new frame collection');
  assert.equal(a.run(`pool.find(item=>item.sample_key==='fresh').label`),'','fresh watch crops remain explicitly unreviewed');
  assert.equal(a.run(`pool.filter(item=>item.sample_key==='fresh').length`),1,'durable recovery does not duplicate labels');
  assert.equal(a.run('labelInput.value'),'unsaved draft');assert.equal(a.run('reviewAwards.recovered.points'),20,'claim merge preserves reward ledger');
  const claim=a.apiCalls.find(call=>call.url==='/api/watch/claim');assert.deepEqual(claim.body,{},'recovery cannot send stale session data over later labels');assert.ok(a.apiCalls.every(call=>call.dataset==='a'));
  assert.equal(a.run('captureWatch.isActive()'),false);await a.clock.advance(100);assert.equal(a.clock.timers.size,0);
  await a.elements.get('capture-once').onclick();assert.equal(a.apiCalls.filter(c=>c.url==='/api/capture').length,0,'labeling blocks Capture button');

  const hidden=appFixture();let previews=0,cancels=0;
  hidden.sandbox.window.CollectorCaptureAnimation={present:async()=>previews++,cancel:()=>cancels++};
  const watching=hidden.run(`captureWatch.start({intervalSeconds:2,queueLimit:200})`);await flush();
  hidden.sandbox.document.hidden=true;hidden.listeners.get('visibilitychange')();hidden.resolveTick(frame);await watching;
  assert.equal(hidden.run('frames.length'),1,'background capture still merges admitted crops');
  assert.equal(hidden.run('captureWatch.isActive()'),true,'hiding the collector does not revoke recording');
  assert.equal(previews,0,'background admission never opens a full-frame preview');assert.equal(cancels,1,'hiding cancels an already visible capture preview');
  assert.ok(hidden.saves.length>0,'background crops persist in the session');
  await hidden.clock.advance(2000);
  assert.equal(hidden.apiCalls.filter(call=>call.url==='/api/watch/tick').length,2,'recording schedules another capture while the collector stays hidden');
  assert.equal(previews,0,'continued background captures never replay overlays');
  hidden.sandbox.document.hidden=false;hidden.listeners.get('visibilitychange')();await flush();
  assert.equal(hidden.run('captureWatch.isActive()'),true,'returning leaves the existing recording lease active');
  assert.equal(previews,0,'returning does not replay a backlog of preview animations');
  await hidden.run(`stopAndRecoverWatch('Stopped')`);assert.equal(hidden.run('captureWatch.isActive()'),false);

}
async function collectionDomTests(){
  const {createRequire}=require('node:module');
  const uiRoot=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
  const {JSDOM}=createRequire(path.join(uiRoot,'package.json'))('jsdom');
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../templates/poker_lab.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost/collection'});
  const {window}=dom,context=dom.getInternalVMContext(),captures=[],writes=[],errors=[];
  let pageHidden=false;Object.defineProperty(window.document,'hidden',{get:()=>pageHidden});
  window.console.error=(...args)=>errors.push(args.join(' '));
  window.fetch=async(url,options)=>{writes.push({url,body:options.body&&JSON.parse(options.body)});return {ok:true,status:200,json:async()=>url==='/api/sources' ? window.sourceFixture : ({success:true})};};
  window.CollectorCaptureAnimation={present:async value=>{captures.push({...value,targets:value.prepareTargets()});},cancel(){}};
  require('./helpers/browser.cjs')(window);window.eval(fs.readFileSync(path.join(__dirname,'../static/ui/collector-ui.js'),'utf8'));
  vm.runInContext(watchSource,context);vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),context);vm.runInContext(appSource,context);
  const run=code=>vm.runInContext(code,context);
  try{
    run(`activeDatasetId='dataset-a';isRecovering=false;currentView='collection';
      frameListEl=document.getElementById('frame-list');
      updateStepperButtons=()=>{};renderDatasetNavigator=()=>{};saveSessionProgress=async()=>{};
      pool=[{id:'seat.name',sample_key:'recovered',phash:'recovered-hash',label:'CorrectName',reviewed:true,base64_image:'png'}];
      frames=[{id:'old-frame',source:'old.png',game_id:'old-game',regions:[{id:'seat.status',sample_key:'old',phash:'old',base64_image:'png'}]}];
      renderFrames();`);
    const fresh={id:'new-frame',source:'fresh capture.png',game_id:'fresh-game',watch:true,frame_width:1000,frame_height:800,regions:[{id:'seat.status',sample_key:'fresh-one',phash:'one',base64_image:'png',rect:{x:20,y:30,w:80,h:20}},{id:'seat.bank',sample_key:'fresh-two',phash:'two',base64_image:'png',rect:{x:120,y:30,w:80,h:20}}]};
    const oldCard=window.document.querySelector('[data-sample-key=old]');
    assert.ok(oldCard.querySelector('.card-label') === null,'unreviewed cards do not repeat a full status row');
    assert.ok(oldCard.querySelector('.card-provenance') === null,'capture metadata no longer clutters every card');
    assert.equal(oldCard.querySelectorAll('button').length,2,'direct trash button sits beside the shared action menu');
    assert.ok(oldCard.querySelector('.crop-review-status') === null,'review dot is removed');
    assert.equal(oldCard.querySelector('.crop-remove-button').getAttribute('aria-label'),'Remove crop');
    assert.ok(oldCard.getAttribute('aria-label').includes('Needs review'),'review state remains accessible');
    assert.ok(window.document.querySelector('[data-sample-key=recovered] .card-label').textContent.includes('CorrectName'),'reviewed labels remain visible');
    window.freshFrame=fresh;run('mergeWatchFrames([freshFrame],false)');
    assert.equal(window.document.querySelectorAll('#frame-list img').length,2,'admitted crops stay out of the list until the full-frame preview prepares targets');
    const preview=deferred();window.CollectorCaptureAnimation.present=async value=>{await preview.promise;captures.push({...value,targets:value.prepareTargets()});};
    const showing=run('showCaptureAdmission(freshFrame,freshFrame.regions,()=>true)');
    assert.equal(window.document.querySelectorAll('#frame-list img').length,2,'list insertion waits for flash/ROI preparation rather than image preload');
    preview.resolve();await showing;
    assert.ok(window.document.querySelector('[data-sample-key=old]') === oldCard,'unchanged cards retain their shared roots and interaction state');
    const keys=[...window.document.querySelectorAll('#frame-list > [data-sample-key]')].map(node=>node.dataset.sampleKey);
    assert.deepEqual(keys,['fresh-two','fresh-one','old','recovered'],'new crop cards precede older captures and recovered-only samples');
    assert.equal(window.document.querySelectorAll('#frame-list img').length,4);
    assert.equal(window.document.querySelector('#count-frames-pill').textContent,'2 captures');
    assert.ok(window.document.querySelector('#frame-list').textContent.includes('CorrectName'));
    assert.equal(captures.length,1);assert.equal(captures[0].frame.image_url,'/api/cap_image/fresh%20capture.png?dataset_id=dataset-a');
    assert.equal(captures[0].targets.length,2);assert.ok(captures[0].targets.every(target=>target.element.dataset.sampleKey===target.sampleKey));
    await run('showCaptureAdmission(freshFrame,[],()=>true)');assert.equal(captures.length,1,'duplicate/empty admissions cannot animate');
    await window.document.querySelector('[data-sample-key=fresh-two] .crop-remove-button').onclick();
    assert.equal(writes.at(-1).url,'/api/watch/discard');assert.deepEqual(writes.at(-1).body,{sample_keys:['fresh-two']});
    assert.equal(window.document.querySelectorAll('#frame-list img').length,3);
    assert.equal(run(`pool.find(item=>item.sample_key==='recovered').label`),'CorrectName');
    await run(`removeFrame(frames.findIndex(frame=>frame.id==='new-frame'))`);
    assert.deepEqual(writes.at(-1).body,{frame_ids:['new-frame']});
    assert.equal(window.document.querySelectorAll('#frame-list img').length,2);
    window.failedFrame={...fresh,id:'failed-preview',source:'failed.png',regions:[{...fresh.regions[0],sample_key:'failed-preview-crop',phash:'failed'}]};
    run('mergeWatchFrames([failedFrame],false)');window.CollectorCaptureAnimation.present=async()=>{throw new Error('Preview image failed');};window.console.warn=()=>{};
    await run('showCaptureAdmission(failedFrame,failedFrame.regions,()=>true)');
    assert.ok(window.document.querySelector('[data-sample-key=failed-preview-crop]'),'a preview failure cannot hide an admitted crop');
    run('manualCaptureBusy=false;labelingUnlocked=false;reviewUnlocked=false;initCaptureToolbar();renderWatchStatus({active:false,busy:false,status:"off"})');
    assert.equal(window.document.getElementById('watch-status').textContent,'Ready');
    assert.equal(window.document.getElementById('watch-status-detail').textContent,'Every 2s · New unique crops');
    run(`monitorSelect=document.getElementById('monitor-select');loadMonitors([{name:'DP-2',width:1920,height:1080}],'DP-2')`);
    assert.equal(window.document.getElementById('monitor-select').value,'DP-2');
    assert.equal(window.document.getElementById('monitor-select').selectedOptions[0].textContent,'DP-2');
    assert.equal(window.document.getElementById('monitor-select').title,'DP-2 (1920×1080)');
    window.sourceFixture=[{name:'DP-2',kind:'monitor',width:1920,height:1080},{name:'window:stable-id',kind:'window',app_id:'zen',label:'Zen — Poker table',width:1920,height:1080}];
    run(`loadMonitors(sourceFixture,'window:stable-id')`);
    assert.deepEqual([...window.document.querySelectorAll('#monitor-select optgroup')].map(group=>group.label),['Monitors','Windows']);
    assert.equal(window.document.getElementById('monitor-select').value,'window:stable-id');
    assert.equal(window.document.getElementById('record-source-name').textContent,'zen','dock shows the app instead of its opaque window token');
    assert.equal(window.document.getElementById('monitor-select').title,'Zen — Poker table (1920×1080)');
    window.sourceFixture=[{name:'DP-2',kind:'monitor',width:1920,height:1080}];
    await run('refreshCaptureSources()');
    assert.equal(window.document.getElementById('monitor-select').value,'window:stable-id','inventory refresh cannot silently switch capture targets');
    assert.equal(window.document.getElementById('monitor-select').selectedOptions[0].disabled,true);
    assert.equal(window.document.getElementById('record-source-name').textContent,'Source unavailable');
    run(`loadMonitors(sourceFixture,'DP-2')`);
    pageHidden=true;const priorPreviews=captures.length;
    await run('showCaptureAdmission(freshFrame,freshFrame.regions,()=>true)');
    assert.equal(captures.length,priorPreviews,'hidden DOM admission skips the overlay entirely');
    pageHidden=false;

    assert.equal(window.document.getElementById('capture-once').disabled,false);
    run('renderWatchStatus({active:true,busy:true,status:"checking",added:7})');
    assert.equal(window.document.getElementById('watch-status').textContent,'Recording');
    assert.equal(window.document.getElementById('watch-status-detail').textContent,'7 new crops this run');
    assert.equal(window.document.getElementById('capture-once').disabled,true);
    assert.equal(window.document.getElementById('watch-start').classList.contains('hidden'),true);
    assert.equal(window.document.getElementById('watch-stop').classList.contains('hidden'),false);
    run('renderWatchStatus({active:true,busy:false,status:"rate_paused",added:7})');
    assert.equal(window.document.getElementById('watch-status').textContent,'Recording');
    run('renderWatchStatus({active:false,busy:false,status:"error",message:"Monitor unavailable"})');
    assert.equal(window.document.getElementById('watch-status').textContent,'Error');
    assert.equal(window.document.getElementById('watch-status-detail').textContent,'Monitor unavailable');
    const settings=window.document.getElementById('watch-settings');
    const intervalField=window.document.getElementById('watch-interval');
    window.CollectorSharedUi.setRecordingSourceOpen('watch-settings',true);
    assert.ok(window.document.getElementById('watch-interval') === intervalField,'opening settings retains the native field');
    window.document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await new Promise(resolve=>window.setTimeout(resolve,0));
    assert.equal(settings.dataset.recordingSourceOpen,'false');assert.ok(window.document.activeElement === settings.querySelector('[data-recording-source-trigger]'),'Escape restores gear focus');
    window.CollectorSharedUi.setRecordingSourceOpen('watch-settings',true);await new Promise(resolve=>window.setTimeout(resolve,0));
    // Radix defers primary-button dismissal until the outside click completes.
    for (const type of ['pointerdown','pointerup','click']) window.document.body.dispatchEvent(new window.MouseEvent(type,{button:0,bubbles:true}));
    await new Promise(resolve=>window.setTimeout(resolve,0));
    assert.equal(settings.dataset.recordingSourceOpen,'false','outside press closes capture settings');
    assert.ok(window.document.getElementById('watch-interval') === intervalField,'closed settings retain fields for the native controller');
    run('renderWatchStatus({active:false,busy:false,status:"off"})');
    window.document.getElementById('watch-interval').value='5';window.document.getElementById('watch-interval').dispatchEvent(new window.Event('change',{bubbles:true}));
    assert.equal(window.document.getElementById('watch-settings-summary'),null);
    assert.equal(window.document.getElementById('watch-status-detail').textContent,'Every 5s · New unique crops');
    run('frames=[];pool=[];watchNeedsRecovery=false;renderCapturePresentation()');
    assert.equal(window.document.getElementById('btn-clear-frames').disabled,true,'empty Ready state disables Clear');
    run('manualCaptureBusy=true;renderCapturePresentation()');
    assert.equal(window.document.getElementById('btn-clear-frames').disabled,false,'pending capture work still permits stop/clear');
    assert.equal(errors.length,0,errors.join('\n'));
  }finally{window.close();}
}
(async()=>{await controllerTests();await appTests();await collectionDomTests();console.log('PASS: opt-in watch; sequential deferred requests; per-frame/queue bounds with no minute cap; stale stop/navigation guards; background collection without overlays; durable claim before labeling; pool/draft/reward preservation; no reload resume; manual exclusion; animation completion fence; real-DOM newest-first crop insertion/provenance/targets/removal.');})().catch(error=>{console.error(error);process.exitCode=1;});
