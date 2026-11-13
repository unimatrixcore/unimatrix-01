// Actual emitted typed registry + legacy event handler, using synthetic DOM/network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const uiRoot=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(uiRoot,'package.json'))('jsdom');
const source=fs.readFileSync(path.join(__dirname,'../static/js/app.js'),'utf8').replace('init().catch(error => { showLoading(false); showToast(error.message, "error"); });','');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
function fixture(){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../templates/poker_lab.html'),'utf8'),{runScripts:'outside-only',url:'http://localhost/collection'});
  const {window}=dom,context=dom.getInternalVMContext();
  Object.defineProperty(window.document,'hidden',{get:()=>false});
  window.fetch=async()=>({ok:true,status:200,json:async()=>({success:true})});
  require('./helpers/browser.cjs')(window);window.eval(fs.readFileSync(path.join(__dirname,'../static/ui/collector-ui.js'),'utf8'));
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/js/lib/watch_capture.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/js/lib/ui.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),context);vm.runInContext(source,context);
  const run=code=>vm.runInContext(code,context);
  run(`activeDatasetId='synthetic';currentView='collection';isRecovering=false;datasetSwitching=false;labelingUnlocked=false;reviewUnlocked=false;
    monitorSelect=document.getElementById('monitor-select');monitorSelect.appendChild(new Option('DP-2','DP-2'));monitorSelect.value='DP-2';
    frameListEl=document.getElementById('frame-list');viewCollection=document.getElementById('view-collection');viewLabeling=document.getElementById('view-labeling');viewSessionReview=document.getElementById('view-session-review');viewDatabase=document.getElementById('view-database');viewLabelingStats=document.getElementById('labeling-stats-card');labelInput=document.getElementById('label-input');
    updateStepperButtons=()=>{};saveSessionProgress=async()=>{};renderDatasetNavigator=()=>{};`);
  const start=source.indexOf('  window.onkeydown = (e) => {'),end=source.indexOf('  initMagnifier();',start);
  run(source.slice(start,end));
  const emit=(target,key,options={})=>{target.focus?.();const event=new window.KeyboardEvent('keydown',{key,code:key===' '?'Space':key==='Escape'?'Escape':`Key${key.toUpperCase()}`,bubbles:true,cancelable:true,...options});target.dispatchEvent(event);return event;};
  return {dom,window,run,emit};
}
async function keyboardTests(){
  const f=fixture(),{window,run,emit}=f,{document}=window;
  const calls={capture:0,start:0,stop:0};window.testCalls=calls;
  run(`captureFrame=async()=>testCalls.capture++;captureWatch={isActive:()=>!!globalThis.recording,isBusy:()=>false};
    document.getElementById('watch-start').onclick=()=>{testCalls.start++;globalThis.recording=true};
    stopAndRecoverWatch=async()=>{testCalls.stop++;globalThis.recording=false;document.querySelector('.capture-arrival')?.remove()};
    initCaptureToolbar();`);
  try{
    for(const target of [document.body,document.getElementById('capture-once'),document.getElementById('nav-collection'),document.querySelector('#watch-settings [data-recording-source-trigger], #watch-settings summary')])emit(target,'c');
    assert.equal(calls.capture,4,'C works from body, Capture, other focused buttons, and closed summary');
    emit(document.body,' ');assert.equal(calls.capture,5);
    for(const target of [document.getElementById('capture-once'),document.getElementById('nav-collection'),document.querySelector('#watch-settings [data-recording-source-trigger], #watch-settings summary')]){
      const event=emit(target,' ');assert.equal(event.defaultPrevented,false,'Space retains native button/summary activation');
    }
    assert.equal(calls.capture,5,'native Space is never also a global capture');
    document.getElementById('capture-once').click();assert.equal(calls.capture,6,'Capture button remains wired independently');
    for(const key of ['c','w',' ']){
      emit(document.body,key,{repeat:true});
      for(const modifier of ['ctrlKey','metaKey','altKey','shiftKey'])emit(document.body,key,{[modifier]:true});
    }
    assert.equal(calls.capture,6);assert.equal(calls.start,0,'held/modifier keys cannot dispatch recording commands');
    const fields=[document.createElement('input'),document.createElement('textarea'),document.createElement('select'),document.createElement('div')];fields[3].setAttribute('contenteditable','true');
    for(const field of fields){document.body.append(field);run('globalThis.recording=true');for(const key of ['c','w',' ','Escape'])emit(field,key);field.remove();}
    assert.equal(calls.capture,6);assert.equal(calls.start,0);assert.equal(calls.stop,0,'editable fields retain all keys, including Escape');
    run('globalThis.recording=false');emit(document.body,'w');assert.equal(calls.start,1);
    emit(document.getElementById('capture-once'),'w');await flush();assert.equal(calls.stop,1,'W toggles off even from a focused button');
    run('globalThis.recording=true');const settings=document.getElementById('watch-settings');
    window.CollectorSharedUi.setRecordingSourceOpen('watch-settings',true);
    emit(settings.querySelector('[data-recording-source-trigger], summary'),'Escape');await new Promise(resolve=>window.setTimeout(resolve,0));assert.equal(settings.dataset.recordingSourceOpen,'false');assert.equal(calls.stop,1,'popover gets Escape before record transport');
    window.CollectorSharedUi.setRecordingSourceOpen('watch-settings',true);emit(document.body,'c');emit(document.body,'w');assert.equal(calls.capture,6);assert.equal(calls.stop,1);window.CollectorSharedUi.setRecordingSourceOpen('watch-settings',false);
    const modal=run(`showConfirmModal('Synthetic confirmation','No captures should run')`);emit(document.getElementById('btn-modal-cancel'),'c');emit(document.getElementById('btn-modal-cancel'),'w');
    assert.equal(calls.capture,6);assert.equal(calls.stop,1);
    emit(document.getElementById('btn-modal-cancel'),'Escape');assert.equal(await modal,false);assert.equal(calls.stop,1,'modal Escape closes only the modal');
    const preview=document.createElement('div');preview.className='capture-arrival';const stop=document.getElementById('watch-stop');stop.classList.remove('hidden');stop.disabled=false;preview.append(stop.parentElement);document.body.append(preview);
    emit(stop,'Escape');await flush();assert.equal(calls.stop,2,'Escape on the focused portalled Stop button stops the recording');assert.equal(document.querySelector('.capture-arrival'),null);
    assert.ok(document.getElementById('record-key-hints').textContent.includes('Space / C'));
    assert.ok(document.getElementById('record-key-hints').textContent.includes('W'));
    assert.ok(document.getElementById('record-key-hints').textContent.includes('Esc'));
    assert.ok(document.getElementById('review-edit-key-hints').textContent.includes('Alt+Tab'));
    assert.ok(!document.getElementById('review-edit-key-hints').textContent.includes('Ctrl+Tab'));
  }finally{f.dom.window.close();}
}
async function manualStopAndReserveTests(){
  const f=fixture(),{window,run,emit}=f,{document}=window,network=deferred();let previews=0,cancels=0,requests=0;
  window.fetch=async()=>{requests++;return {ok:true,status:200,json:()=>network.promise};};
  run(`datasetFetch=async()=>({json:async()=>await globalThis.manualResponse});`);
  window.manualResponse=network.promise;
  window.CollectorCaptureAnimation={present:async()=>previews++,cancel:()=>cancels++};
  let height=190,resize;const dock=document.getElementById('record-dock');dock.getBoundingClientRect=()=>({height});
  window.ResizeObserver=class{constructor(callback){resize=callback;}observe(){}};
  try{
    run('initCaptureWatch()');
    assert.equal(document.getElementById('view-collection').style.getPropertyValue('--record-dock-space'),'238px');height=260;resize();assert.equal(document.getElementById('view-collection').style.getPropertyValue('--record-dock-space'),'308px','wrapped dock height reserves scroll space');
    const capture=run('captureFrame()');await flush();emit(document.getElementById('capture-once'),'Escape');await flush();
    network.resolve({source:'manual.png',game_id:'123',frame_width:1920,frame_height:1080,regions:[{id:'seat.name',phash:'abc',sample_key:'manual-crop',base64_image:'png',rect:{x:1,y:2,w:20,h:10}}]});
    await capture;assert.equal(previews,0,'Escape before response suppresses a surprise late preview');assert.ok(cancels>0);
    assert.equal(run('frames.length'),1);assert.equal(document.querySelectorAll('#frame-list [data-sample-key]').length,1,'already admitted manual crops remain visible after cancellation');assert.equal(requests,0);
  }finally{f.dom.window.close();}
}
(async()=>{await keyboardTests();await manualStopAndReserveTests();console.log('PASS: emitted typed recording registry; C/Space/W/Escape focus behavior; modifiers/repeats/native Space; edit/modal/popover priority; portalled Stop; cancelled late manual preview; visible hints and measured dock reserve.');})().catch(error=>{console.error(error);process.exitCode=1;});
