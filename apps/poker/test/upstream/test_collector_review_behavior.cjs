// Run with node; no browser, capture, live corpus, or model process is involved.
const fs = require('fs'), vm = require('vm'), assert = require('assert'), path = require('path'), os = require('os');
const ts = require('typescript');
// Exercise the actual shared helper implementation used by the collector UI build.
const uiRoot = process.env.UNIMATRIX_UI_ROOT || path.join(os.homedir(), 'repositories/unimatrix-01/packages/ui');
const helperSource = fs.readFileSync(path.join(uiRoot, 'src/lib/gamification.ts'), 'utf8');
const helperModule = {exports:{}};
vm.runInNewContext(ts.transpileModule(helperSource, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {exports:helperModule.exports,module:helperModule});
const sharedCalls = new Map();
const reviewGamification = Object.fromEntries(Object.entries(helperModule.exports).map(([name, value]) => [name, typeof value === 'function' ? (...args) => {sharedCalls.set(name,(sharedCalls.get(name)||0)+1);return value(...args);} : value]));
let now = 1000, network = async () => ({event:{id:'review-event'},success:true});
const calls = [], storage = new Map(), elements = new Map();
const classes = () => { const values=new Set(['hidden']);return {add(...names){names.forEach(name=>values.add(name));},remove(...names){names.forEach(name=>values.delete(name));},toggle(name,force){const next=force===undefined?!values.has(name):force;next?values.add(name):values.delete(name);return next;},replace(from,to){if(values.delete(from))values.add(to);},contains(name){return values.has(name);}}; };
function element(id='') {
  if (!elements.has(id)) elements.set(id, {id,value:'',textContent:'',disabled:false,title:'',children:[],style:{setProperty(name,value){this[name]=value;}},classList:classes(),setAttribute(){},replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);},append(...children){this.children.push(...children);},focus(){},blur(){},select(){},dispatchEvent(){},setSelectionRange(){},matches(){return true;},closest(){return element('input-group');}});
  return elements.get(id);
}
class ClockDate extends Date { static now(){return now;} }
const sandbox = {console, Headers, URLSearchParams, Event, Date:ClockDate, Promise, setTimeout, clearTimeout,
  OCR_CONTRACT:JSON.parse(fs.readFileSync('dev_tools/ocr_contract.json','utf8')),
  localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  sessionStorage:{getItem(){return null;},removeItem(){}},
  document:{getElementById:element,createElement:tag=>element('created-' + tag + '-' + Math.random())},
  window:{CollectorSharedUi:{reviewGamification},setTimeout,fetch:async(url,opts)=>{calls.push({url,opts});const data=await network(url,opts);return {ok:!data.httpError,status:data.httpError||200,json:async()=>data};}},history:{},showToast(){}};
vm.createContext(sandbox);
const source = fs.readFileSync('dev_tools/static/js/app.js','utf8').replace('init().catch(error => { showLoading(false); showToast(error.message, "error"); });','').replace('const setView =', 'let setView ='); // Allow replacing only the DOM view renderer in this VM.
vm.runInContext(fs.readFileSync('dev_tools/static/js/lib/scoring.js','utf8'),sandbox);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),sandbox);vm.runInContext(source,sandbox);
vm.runInContext(fs.readFileSync('dev_tools/static/js/lib/schemas.js','utf8'),sandbox);
const run = code => vm.runInContext(code,sandbox);
assert.equal(run(`Schemas.STATUS.validate('Fold').isValid`),true);
assert.equal(run(`Schemas.STATUS.validate('Hide Cards').isValid`),true);
assert.equal(run(`Schemas.STATUS.validate('Away').isValid`),true);
assert.equal(run(`Schemas.STATUS.isPartial('Hide C')`),true);
assert.equal(run(`Schemas.STATUS.isPartial('Fo')`),true);
for (const text of ['fold','Folded','F0ld']) assert.equal(run(`Schemas.STATUS.validate(${JSON.stringify(text)}).isValid`),false);
run(`
  activeDatasetId='dataset-a'; isRecovering=false;
  labelInput=document.getElementById('label-input');
  viewLabelingStats=document.getElementById('labeling-stats-card');
  viewLabeling=document.getElementById('view-labeling');viewLabeling.classList.remove('hidden');
  currentView='labeling';
  updateStepperButtons=()=>{};renderDatasetNavigator=()=>{};showLabelingStats=()=>{};
  syncPoolsWithLabelChange=()=>{};refreshLabelHistory=()=>{};renderDatabase=()=>{};
  usernamePool={getItems:()=>[],has:()=>true,counts:{clear(){}},getCount:()=>2,add(){},remove(){}};
  globalThis.effects=[];showFloatingScore=(...effect)=>effects.push(effect);
  inputGroup=document.getElementById('input-group');
`);
function reset(key='sample-a', prediction={id:'prediction-a',text:'Alice',raw_text:'Alice',schema_valid:true}) {
  sandbox.fixturePrediction=prediction;
  run(`pool=[{id:'seat.name',sample_key:${JSON.stringify(key)},base64_image:'png',label:''}];
      frames=[];currentReviewIdx=0;reviewSaving=false;sessionScore=0;currentCombo=0;maxCombo=0;reviewAwards={};
      modelPrediction=fixturePrediction;resetReviewClock();startReviewClock(pool[0]);labelInput.value='Alice';usedAutoComplete=false;isPaused=false;lastValue='';actionHistory=[];quickLabels=0;autoCompletes=0;currentValidationError=null;currentView='labeling';effects=[];`);
}
(async()=>{
  for (let number=1;number<=9;number++) {
    assert.equal(run(`Schemas.NAME.validate('Player ${number}').isValid`),true);
    assert.equal(run(`Schemas.NAME.isPartial('Player ${number}')`),true);
  }
  for (const label of ['Player 0','Player 10','player 1','Player  1','Player\t1','Player 1...','Other Name']) {
    sandbox.nameCase=label;
    assert.equal(run('Schemas.NAME.validate(nameCase).isValid'),false,label);
  }
  assert.equal(run("Schemas.NAME.validate('Alice123...').isValid"),true);
  reset('player-typing');
  const beforeInputStart=source.indexOf('  labelInput.onbeforeinput = (e) => {');
  vm.runInContext(source.slice(beforeInputStart,source.indexOf('  labelInput.oninput',beforeInputStart)),sandbox);
  element('label-input').value='Player';element('label-input').selectionStart=6;element('label-input').selectionEnd=6;
  let blocked=false;
  element('label-input').onbeforeinput({inputType:'insertText',data:' ',preventDefault(){blocked=true;}});
  assert.equal(blocked,false,'the literal space after Player can be typed');
  element('label-input').value='Player ';element('label-input').selectionStart=7;element('label-input').selectionEnd=7;
  element('label-input').onbeforeinput({inputType:'insertText',data:'0',preventDefault(){blocked=true;}});
  assert.equal(blocked,true,'Player 0 remains blocked while typing');
  reset();
  now += 1700;
  const before = run('reviewElapsed()');
  run('useModelSuggestion()');
  now += 12000;
  assert.equal(run('reviewElapsed()'),before,'copy/edit freezes elapsed time beyond the former five-second deadline');
  run('checkComboExpiration()');
  assert.match(element('timer-display').title,/Editing paused/);
  assert.equal(run('sessionScore'),0,'copy does not award points');
  assert.equal(calls.length,0,'copy never saves ground truth');
  run('persistReviewDraft()');
  const frozenDraft=JSON.parse(storage.get('ocr:dataset-a:draft:sample-a'));
  assert.ok(frozenDraft.clock.pauseReasons.includes('editing'));
  assert.equal(frozenDraft.clock.elapsedMs,before);
  run(`resetReviewClock(); startReviewClock(pool[0],JSON.parse(datasetStorage.getItem(draftKey())).clock)`);
  now += 6000;
  assert.equal(run('reviewElapsed()'),before,'frozen elapsed survives draft recovery');
  run('togglePause(); togglePause()'); now += 1000;
  assert.equal(run('reviewElapsed()'),before,'manual pause cannot resume an editing freeze');
  await run('acceptModelSuggestion()');
  assert.equal(run('sessionScore'),60,'successful model acceptance earns the original autocomplete bonus');
  assert.ok(run("effects.some(effect=>effect[0]===60 && effect[1]==='model_accept')"),'model acceptance has its own feedback category');
  assert.ok(run("effects.every(effect=>effect[1]!=='auto')"),'acceptance does not use the autocomplete category');
  assert.equal(run('currentCombo'),1);
  assert.equal(run('pool[0].review_reward.points'),60);
  assert.equal(run('pool[0].label'),'Alice');
  const saved=JSON.parse(calls.findLast(call=>call.url==='/api/save_session_progress').opts.body);
  assert.equal(saved.pool[0].review_reward.points,60);
  assert.equal(saved.reviewAwards['sample-a'].points,60,'award ledger persists with session JSON');
  await run("persistReview(pool[0], 'Alice', 'accept')");
  assert.equal(run('sessionScore'),60,'identical reviewed state does not mint another save bonus');
  run(`sessionScore=500;usedAutoComplete=false;startReviewClock(pool[0],{elapsedMs:1000,pauseReasons:[]});`);
  await run("persistReview(pool[0], 'Bob', 'correct')");
  assert.equal(run('sessionScore'),500,'prior-label correction pays original -100 then quick-save +100');
  assert.equal(run('currentCombo'),1,'correction resets multiplier before its normal quick reward');
  assert.ok(run("effects.some(effect=>effect[0]==='CORRECTION -100')"));
  run(`pool[0]={id:'seat.name',sample_key:'sample-a',label:''};`);
  await run("persistReview(pool[0], 'Bob', 'correct')");
  assert.equal(run('sessionScore'),500,'recreated pool crop cannot bypass same-state session ledger');

  reset('correction');
  await run("persistReview(pool[0], 'CorrectedName', 'correct')");
  assert.equal(run('sessionScore'),100,'manual correction earns original quick-label points');
  reset('unchanged');
  await run("persistReview(pool[0], 'Alice', 'correct')");
  assert.equal(run('sessionScore'),100,'typed save retains quick-label reward');
  reset('manual',null);
  await run("persistReview(pool[0], 'ManualName', 'correct')");
  assert.equal(run('sessionScore'),100,'manual review retains original quick-label reward');
  reset('discovery');
  run('usernamePool.has=()=>false');
  await run("persistReview(pool[0], 'NewName', 'correct')");
  assert.equal(run('sessionScore'),150,'new username adds original discovery bonus');
  assert.ok(run("effects.some(effect=>effect[0]==='NEW NAME +50')"));
  reset('model-discovery');
  await run("persistReview(pool[0], 'NewName', 'accept')");
  assert.equal(run('sessionScore'),110,'model acceptance and discovery keep their existing total reward');
  assert.ok(run("effects.some(effect=>effect[0]===60 && effect[1]==='model_accept')"),'discovery does not swallow the model reward');
  assert.ok(run("effects.some(effect=>effect[0]==='NEW NAME +50' && effect[1]==='name_bonus')"));
  run('usernamePool.has=()=>true');

  reset('failure');
  network=async()=>({httpError:503,error:'Review unavailable'});
  await run('acceptModelSuggestion()');
  assert.equal(run('sessionScore'),0,'backend failure earns nothing');
  assert.equal(run('pool[0].reviewed'),undefined);
  network=async()=>({success:false,error:'No review persisted'});
  await run('acceptModelSuggestion()');
  assert.equal(run('sessionScore'),0,'application-level failure earns nothing');

  // Save latency never consumes the game's five-second read-time window.
  reset('slow-save');
  now += 4000;
  let finishSave;
  network=async(url)=>url==='/api/review_label'?new Promise(resolve=>{finishSave=resolve;}):{};
  const saving=run('acceptModelSuggestion()');
  now += 9000;
  assert.equal(run('sessionScore'),0,'pending backend save has no reward');
  assert.equal(run('reviewElapsed()'),4000,'write latency is excluded');
  finishSave({event:{id:'slow-review'},success:true});
  await saving;
  assert.equal(run('sessionScore'),60,'slow successful backend write keeps the original timed bonus');
  network=async()=>({event:{id:'review-event'},success:true});

  reset('recovered-receipt');
  run("restoreReviewAward(pool[0], {points:20,action:'correct',label:'Recovered'})");
  assert.equal(run('sessionScore'),20);
  run("restoreReviewAward(pool[0], {points:20,action:'correct',label:'Recovered'})");
  assert.equal(run('sessionScore'),20,'shared receipt restoration deduplicates samples');
  assert.equal(run('currentCombo'),1);

  // Exercise the real keyboard handler, including held Ctrl+Enter on the next crop.
  const keyStart=source.indexOf('  window.onkeydown = (e) => {');
  const keyEnd=source.indexOf('  initMagnifier();',keyStart);
  vm.runInContext(source.slice(keyStart,keyEnd),sandbox);
  run(`globalThis.accepts=0;globalThis.copies=0;const originalAccept=acceptModelSuggestion;const originalCopy=useModelSuggestion;
       acceptModelSuggestion=()=>{globalThis.accepts++};useModelSuggestion=()=>{globalThis.copies++};`);
  const key=repeat=>({key:'Enter',ctrlKey:true,repeat,target:element('label-input'),preventDefault(){}});
  sandbox.window.onkeydown(key(true));
  assert.equal(sandbox.accepts,0,'key repeat cannot mass-accept');
  sandbox.window.onkeydown(key(false));
  assert.equal(sandbox.accepts,1);
  run('acceptModelSuggestion=originalAccept;useModelSuggestion=originalCopy;');
  reset('keyboard-copy'); now += 100;
  sandbox.window.onkeydown({key:'Tab',altKey:true,repeat:false,target:element('label-input'),preventDefault(){}});
  now += 6000;assert.equal(run('reviewElapsed()'),100);assert.equal(run('sessionScore'),0);
  reset('old-shortcut');now += 150;
  let oldShortcutPrevented=false;
  sandbox.window.onkeydown({key:'Tab',ctrlKey:true,repeat:false,target:element('label-input'),preventDefault(){oldShortcutPrevented=true;}});
  now += 6000;assert.equal(oldShortcutPrevented,false,'Ctrl+Tab returns to the browser');
  assert.equal(run('reviewClockReason()'),'','old shortcut does not freeze editing');

  const inputStart=source.indexOf('  labelInput.oninput = (e) => {');
  const inputEnd=source.indexOf('  document.getElementById("review-search")',inputStart);
  vm.runInContext(source.slice(inputStart,inputEnd),sandbox);
  run('validateInput=()=>{};updateAutocomplete=()=>{}');
  reset('typing');
  element('label-input').value='Alice';element('label-input').oninput({inputType:'insertText',data:'Alice'});
  assert.equal(run('sessionScore'),25,'original typing reward is five per acceptable inserted character');
  element('label-input').value='Ali';element('label-input').oninput({inputType:'deleteContentBackward'});
  assert.equal(run('sessionScore'),5,'original deletion penalty is ten per character');
  assert.ok(run("effects.some(effect=>effect[0]===-20&&effect[1]==='delete')"));
  reset('typing-multiplier');run('currentCombo=10');
  element('label-input').value='AB';element('label-input').oninput({inputType:'insertText',data:'AB'});
  assert.equal(run('sessionScore'),30,'typing uses original x3 combo multiplier');
  element('label-input').value='';element('label-input').oninput({inputType:'historyUndo'});
  assert.equal(run('sessionScore'),0,'undo restores original multiplied deletion penalty');
  assert.deepEqual(Array.from(run('[0,4,5,9,10,19,20].map(getComboMultiplier)')),[1,1,2,2,3,3,5]);

  reset('tab');
  run(`currentCombo=5;usernamePool.getItems=()=>['Alice'];currentSuggestion='Alice';labelInput.value='Al';lastValue='Al';`);
  sandbox.document.execCommand=(command,unused,text)=>{element('label-input').value+=text;element('label-input').oninput({inputType:'insertText',data:text});};
  sandbox.window.onkeydown({key:'Tab',ctrlKey:false,repeat:false,target:element('label-input'),preventDefault(){}});
  assert.equal(element('label-input').value,'Alice');
  assert.equal(run('sessionScore'),45,'Tab awards rounded 7.5 per inserted character times combo, without typing double count');
  assert.ok(run("effects.some(effect=>effect[0]===45&&effect[1]==='tab')"));

  reset('expired');run('currentCombo=10');now+=5100;run('checkComboExpiration()');
  assert.equal(element('combo-multiplier').textContent,'x1','displayed multiplier expires after five seconds');
  assert.equal(element('timer-display').style.color,'var(--destructive)');
  await run("persistReview(pool[0], 'Alice', 'correct')");
  assert.equal(run('sessionScore'),0,'slow save loses original quick bonus');
  assert.equal(run('currentCombo'),0);
  reset('warning');run('currentCombo=5');now+=3500;run('checkComboExpiration()');
  assert.equal(element('timer-display').style.color,'var(--game-combo-5)');
  assert.ok(element('combo-badge').classList.contains('warning'));
  assert.ok(element('combo-badge').classList.contains('jiggle'));
  assert.ok(element('input-group').classList.contains('combo-x2'));

  reset('blank');
  await run("persistReview(pool[0], '', 'correct')");
  assert.equal(run('pool[0].reviewed'),true);assert.equal(run('pool[0].discarded'),false);
  const blankPoints=run('sessionScore');
  await run("persistReview(pool[0], '', 'correct')");
  assert.equal(run('sessionScore'),blankPoints,'explicit reviewed blank cannot mint a repeated bonus');

  reset('quick-multiplier');run('currentCombo=10');
  await run("persistReview(pool[0], 'Alice', 'correct')");
  assert.equal(run('sessionScore'),300,'quick save preserves original x3 reward');
  assert.equal(run('currentCombo'),11);assert.equal(run('maxCombo'),11);
  reset('discard');run('currentCombo=5');now+=500;
  run('processGamification(false,true)');
  assert.equal(run('sessionScore'),40,'subsecond discard earns20 times multiplier');
  assert.equal(run('currentCombo'),6);
  run('pool[0].discarded=true;processGamification(false,true)');
  assert.equal(run('sessionScore'),40,'same discarded state cannot mint a second bonus');
  reset('late-discard');run('currentCombo=5');now+=1500;
  run('processGamification(false,true)');
  assert.equal(run('sessionScore'),0);assert.equal(run('currentCombo'),6,'discard within5seconds keeps combo without subsecond bonus');
  reset('expired-discard');run('currentCombo=5');now+=5500;
  run('processGamification(false,true)');
  assert.equal(run('sessionScore'),0);assert.equal(run('currentCombo'),0);

  // Loading latency is excluded while editing remains paused after the model arrives.
  reset('loading');
  let complete;
  network=()=>new Promise(resolve=>{complete=resolve;});
  const loading=run('requestModelSuggestion(pool[0])');
  now += 9000;
  assert.equal(run('reviewElapsed()'),0,'initial model loading does not consume read time');
  complete({prediction:{id:'fresh',text:'Alice',raw_text:'Alice',schema_valid:true}});
  await loading;
  now += 1000;
  assert.equal(run('reviewElapsed()'),1000);

  // A late suggestion never replaces user input or ground truth, including saved DB crops.
  reset('saved-other');
  run(`currentView='database';editingPoolIdx='saved.png';dbEntries=[{filename:'saved.png',id:'seat.name',label:'Original'}];document.getElementById('edit-input-saved.png').value='Draft';`);
  network=async()=>({prediction:{id:'saved-prediction',text:'Suggested',raw_text:'Sug gested',schema_valid:true,model_id:'local'}});
  await run("requestDbSuggestion('saved.png')");
  assert.equal(run('dbEntries[0].label'),'Original','saved model prediction is read-only');
  assert.equal(element('edit-input-saved.png').value,'Draft','prediction cannot overwrite a DB edit draft');
  const writesBefore=calls.filter(call=>call.url==='/api/review_label').length;
  run("useDbSuggestion('saved.png')");
  assert.equal(element('edit-input-saved.png').value,'Suggested');
  assert.equal(calls.filter(call=>call.url==='/api/review_label').length,writesBefore);
  network=async()=>({event:{id:'saved-review'},success:true});
  await run("acceptDbSuggestion('saved.png')");
  const dbReview=JSON.parse(calls.findLast(call=>call.url==='/api/review_label').opts.body);
  assert.equal(dbReview.action,'accept'); assert.equal(dbReview.prediction_id,'saved-prediction');
  assert.equal(dbReview.filename,'saved.png'); assert.equal(run('dbEntries[0].label'),'Suggested');
  assert.equal(run('sessionScore'),0,'saved DB edits do not mint session rewards');

  run(`editingPoolIdx='saved.png';dbEntries[0].prediction=null;dbEntries[0].prediction_id=null;`);
  network=()=>new Promise(resolve=>{complete=resolve;});
  const late=run("requestDbSuggestion('saved.png')");
  run(`datasetEpoch++;activeDatasetId='dataset-b';dbEntries=[{filename:'saved.png',id:'seat.name',label:'OtherDataset'}];`);
  complete({prediction:{id:'late',text:'WrongDataset',raw_text:'WrongDataset',schema_valid:true}});
  await late;
  assert.equal(run('dbEntries[0].prediction'),undefined,'late DB suggestion cannot bind to another dataset');
  assert.equal(run('dbEntries[0].label'),'OtherDataset');

  reset('away-contract-refresh',{id:'old-away',text:'Away',raw_text:'Away',category:'status',schema_valid:false});
  run("pool[0].id='seats[1].status';labelInput.value='';");
  const beforeAway=calls.filter(call=>call.url==='/api/review_label').length;
  await run('acceptModelSuggestion()');
  assert.equal(calls.filter(call=>call.url==='/api/review_label').length,beforeAway,'stale invalid predictions are not accepted');
  network=async(url)=>url==='/api/model_suggestion' ? {prediction:{id:'current-away',text:'Away',raw_text:'Away',category:'status',schema_valid:true}} : {event:{id:'away-review',outside_contract:0,schema_valid:1},success:true};
  await run('requestModelSuggestion(pool[0])');
  sandbox.window.onkeydown(key(false));
  await new Promise(resolve=>setImmediate(resolve));
  const away=JSON.parse(calls.findLast(call=>call.url==='/api/review_label').opts.body);
  assert.equal(away.label,'Away');assert.equal(away.action,'accept');
  assert.equal(away.allow_outside_contract,false);assert.equal(away.prediction_id,'current-away');
  assert.equal(run('pool[0].label'),'Away');
  assert.equal(run('pool[0].review_event.outside_contract'),0);

  // A new status can be retained as human truth, without enabling model acceptance.
  reset('novel-status',{id:'novel-prediction',text:'New Table Status',raw_text:'New Table Status',category:'status',schema_valid:false});
  run(`pool[0].id='seats[0].status';labelInput.value='New Table Status';`);
  network=async()=>({event:{id:'novel-review',outside_contract:1,schema_valid:0},success:true});
  const beforeNovel=calls.filter(call=>call.url==='/api/review_label').length;
  await run('acceptModelSuggestion()');
  assert.equal(calls.filter(call=>call.url==='/api/review_label').length,beforeNovel,'unlisted status cannot auto-accept');
  await run('saveCurrentAndNext()');
  const novel=JSON.parse(calls.findLast(call=>call.url==='/api/review_label').opts.body);
  assert.equal(novel.allow_outside_contract,true,'Enter explicitly confirms the human transcription');
  assert.equal(novel.action,'correct');assert.equal(novel.label,'New Table Status');
  assert.equal(run('pool[0].label'),'New Table Status');

  // Legacy arcade totals and malformed clocks cannot crash migration or create points.
  run('renderFrames=()=>{}');
  await run(`recoverSession({frames:[],pool:[{id:'seat.name',sample_key:'legacy-reviewed',label:'Alice',reviewed:true,review_reward:{points:10,action:'accept',label:'Alice'}}],sessionScore:-40,currentCombo:'bad',reviewAwards:{receipt:{points:20},invalid:{points:-2}}})`);
  assert.equal(run('sessionScore'),0);assert.equal(run('currentCombo'),0);
  assert.equal(run('Object.hasOwn(reviewAwards,"receipt")'),true,'valid recorded sample IDs survive corrupt legacy totals');
  assert.equal(run('Object.hasOwn(reviewAwards,"invalid")'),false);
  assert.equal(run('Object.hasOwn(reviewAwards,"legacy-reviewed")'),true);
  run(`startReviewClock(pool[0],{elapsed_ms:-3,frozen:true,reason:'unknown'})`);
  assert.equal(run('reviewElapsed()'),0,'malformed legacy clock safely resets');
  now+=400;assert.equal(run('reviewElapsed()'),400);
  assert.equal(run('sessionScore'),0,'clock migration cannot mint reward points');
  run(`restoreReviewAward(pool[0],{points:-8,action:'accept',label:''})`);
  assert.equal(run('sessionScore'),0,'invalid draft receipts cannot mint rewards');
  run(`pool=[{id:'seat.name',sample_key:'legacy-reviewed',label:''}];awardReviewedSample(pool[0],'Alice','accept',{text:'Alice'},false)`);
  assert.equal(run('sessionScore'),0,'known prior identical reviews remain blocked after migration');
  reset('prior-reviewed');
  run(`pool[0].label='Alice';awardReviewedSample(pool[0],'Alice','accept',{text:'Alice'},true);pool[0]={id:'seat.name',sample_key:'prior-reviewed',label:''};awardReviewedSample(pool[0],'Alice','accept',{text:'Alice'},false)`);
  assert.equal(run('sessionScore'),0,'shared zero-point prior-review marker blocks recreated-item farming');

  const poolRulesStart=source.indexOf('function syncPoolsWithLabelChange(');
  const poolRulesEnd=source.indexOf('function getComboMultiplier(',poolRulesStart);
  vm.runInContext(source.slice(poolRulesStart,poolRulesEnd),sandbox);
  reset('name-correction');run('sessionScore=200;usernamePool.getCount=()=>1');
  run("syncPoolsWithLabelChange('OldName','NewName','name')");
  assert.equal(run('sessionScore'),150,'removing last old-name instance preserves discovery correction penalty');
  run("pool[0].label='NewName';prunePoolsForItem(pool[0])");
  assert.equal(run('sessionScore'),100,'removing last discovered name preserves -50 penalty');
  run('usernamePool.getCount=()=>2');
  run("syncPoolsWithLabelChange('OldName','NewName','name')");
  assert.equal(run('sessionScore'),100,'name correction with other valid instances has no discovery penalty');

  // Verify the real switch/reset path resets score, ledger, and clock before recovery.
  run(`
    datasetSwitching=false;datasetFetch=async()=>({json:async()=>({session:{},db:[],monitors:[],settings:{}})});
    saveSessionProgress=async()=>{};recoverSession=async()=>{};showLoading=()=>{};setModelState=()=>{};
    loadMonitors=()=>{};loadDatabase=()=>{};renderFrames=()=>{};setView=()=>{};
    frameListEl=document.getElementById('frames');sessionReviewListEl=document.getElementById('session-review');dbListEl=document.getElementById('db-list');ghostText=document.getElementById('ghost');
    sessionScore=99;currentCombo=4;reviewAwards={'old':{points:99}};
  `);
  await run("switchDataset('dataset-c')");
  assert.equal(run('sessionScore'),0);assert.equal(run('currentCombo'),0);
  assert.equal(run('Object.keys(reviewAwards).length'),0);assert.equal(run('reviewClock.key'),null);
  const clearStart=source.indexOf('  document.getElementById("btn-clear-frames").onclick = async () => {');
  const clearEnd=source.indexOf('  labelInput.onbeforeinput',clearStart);
  vm.runInContext(source.slice(clearStart,clearEnd),sandbox);
  run('showConfirmModal=async()=>true;sessionScore=100;currentCombo=3;reviewAwards={old:{points:100}}');
  const previousEpoch=run('datasetEpoch');
  await element('btn-clear-frames').onclick();
  assert.equal(run('sessionScore'),0);assert.equal(run('Object.keys(reviewAwards).length'),0);
  assert.equal(run('datasetEpoch'),previousEpoch+1,'session clearing revokes late callbacks');
  for (const helper of ['restoreSampleAward','createAwardLedger','restoreAwardLedger','createReadClock','pauseReadClock','resumeReadClock','readClockElapsedMs','snapshotReadClock','restoreReadClock']) assert.ok(sharedCalls.get(helper)>0, `${helper} must come from the real shared package`);
  console.log('PASS: restored typing/delete/undo/Tab rewards; original multiplier tiers and timed quick/model rewards; warning/expiry; discovery/correction; atomic saves and explicit blanks; shared pause-aware clock/receipt dedup; key repeat; provenance and dataset resets.');
})().catch(error=>{console.error(error);process.exitCode=1;});
