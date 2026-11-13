// Actual collector review UI with a synthetic durable corpus and a one-row labeling buffer.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const ui=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(ui,'package.json'))('jsdom');
const dom=new JSDOM(fs.readFileSync('dev_tools/templates/poker_lab.html','utf8'),{url:'http://localhost/review',runScripts:'outside-only'}),{window}=dom;
const scrollRegion=window.document.createElement('main');
scrollRegion.id='main-content';
window.document.body.append(scrollRegion);
scrollRegion.append(window.document.getElementById('tool-shell'));
const rows=Array.from({length:240},(_,index)=>({queue_id:index+1,sample_key:'full:'+index,id:'seats[0].bank',label:index===0?'OldMarker':index%17===0?'':`S ${index} BB`,reviewed:index!==5,discarded:index===6,prediction_id:'prediction:'+index,image_url:'/api/queue/image/'+(index+1)}));
const calls=[],holds=new Map();
let badResponses=1;
const stats=()=>({total:rows.length,reviewed:rows.filter(r=>r.reviewed).length,items:rows.length,pending:rows.filter(r=>!r.reviewed&&!r.discarded).length,complete:rows.every(r=>r.reviewed||r.discarded),time:240000});
window.matchMedia=()=>({matches:true});
window.fetch=async(url,options={})=>{
  const body=options.body&&JSON.parse(options.body);calls.push({url,body,options});let data;
  if(url.startsWith('/api/queue/review/items?')){
    if(window.holdNextReviewFetch){window.holdNextReviewFetch=false;await new Promise(resolve=>{window.releaseReviewFetch=resolve;});}
    const p=new URL(url,'http://localhost').searchParams,search=p.get('search')||'',filter=p.get('filter'),cursor=Number(p.get('cursor')||0),limit=Number(p.get('limit'));
    if(search==='bad-response' && badResponses-->0) return{ok:false,status:404,json:async()=>{throw new SyntaxError('Unexpected token <, not JSON');}};
    if(search.startsWith('hold')) data=await new Promise(resolve=>holds.set(search,{resolve,signal:options.signal}));
    else {
      const dataset=new window.Headers(options.headers).get('X-Dataset-ID');
      const matches=dataset==='fixture'?rows.filter(r=>(r.id.toLowerCase().includes(search.toLowerCase())||r.label.toLowerCase().includes(search.toLowerCase())) &&
        (filter==='all'||filter==='blank'&&r.reviewed&&!r.discarded&&r.label===''||filter==='pending'&&!r.reviewed&&!r.discarded||filter==='discarded'&&r.discarded||filter==='reviewed'&&r.reviewed&&!r.discarded)):[];
      data={items:matches.slice(cursor,cursor+limit).map(row=>({...row})),next_cursor:cursor+limit<matches.length?String(cursor+limit):null,total:matches.length,review_stats:stats(),summary:{total:rows.length,pending:0}};
    }
  } else if(url==='/api/queue/review/metadata'){
    assert.ok(body.sample_keys.length<=100);
    data={items:rows.filter(row=>body.sample_keys.includes(row.sample_key)).map(row=>({...row})),summary:{total:rows.length,pending:0},review_stats:stats()};
  } else if(url==='/api/review_label'){
    const row=rows.find(r=>r.queue_id===body.queue_id);assert.ok(row);assert.equal(body.prediction_id,row.prediction_id);assert.equal(body.sample_key,row.sample_key);
    row.label=body.label;row.reviewed=true;row.discarded=false;data={success:true,event:{id:'event:'+row.queue_id},summary:{total:rows.length,pending:0}};
  } else if(url==='/api/queue/discard'){
    for(const key of body.sample_keys){const index=rows.findIndex(r=>r.sample_key===key);if(index>=0)rows.splice(index,1);}
    data={success:true,summary:{total:rows.length,pending:0}};
  } else throw new Error('Unexpected request '+url);
  return{ok:true,status:200,json:async()=>data};
};
window.OCR_CONTRACT=JSON.parse(fs.readFileSync('dev_tools/ocr_contract.json','utf8'));
const context=dom.getInternalVMContext();
vm.runInContext(fs.readFileSync('dev_tools/static/js/lib/schemas.js','utf8'),context);
vm.runInContext(fs.readFileSync('dev_tools/static/js/lib/session_review.js','utf8'),context);
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),context);vm.runInContext(fs.readFileSync('dev_tools/static/js/app.js','utf8').replace('init().catch(error => { showLoading(false); showToast(error.message, "error"); });',''),context);
const run=code=>vm.runInContext(code,context),tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const settle=async()=>{await tick();await tick();await tick();};
run(`activeDatasetId='fixture';datasetSwitching=false;queueMode=true;currentView='session-review';isRecovering=false;
sessionReviewListEl=document.getElementById('session-review-list');viewSessionReview=document.getElementById('view-session-review');
pool=[{queue_id:240,sample_key:'full:239',id:'seats[0].bank',label:'S 239 BB',reviewed:true}];reviewBatch={mode:'stream',batch_id:'run',next_cursor:null,keys:pool.map(sampleKey)};
streamStats={total:240,pending:0,complete:true};currentReviewIdx=0;maxReachedIdx=0;sessionScore=777;
showToast=(message,type)=>{if(type==='error')globalThis.lastError=message;};saveSessionProgress=async()=>{};updateStepperButtons=()=>{};syncPoolsWithLabelChange=()=>{};
showConfirmModal=async()=>true;usernamePool={getItems:()=>[]};`);
const setSearch=async value=>{window.document.getElementById('review-search').value=value;run('renderSessionReview()');await new Promise(resolve=>setTimeout(resolve,190));await settle();};
(async()=>{try{
  run('renderSessionReview()');await settle();
  assert.equal(run('fullReviewItems().length'),50);assert.equal(run('fullSessionReview.total'),240);
  assert.ok(window.document.getElementById('review-page-status').textContent.includes('240'));
  const oldImage=window.document.querySelector('[data-review-key="full:0"] img');
  const view=window.document.getElementById('main-content');
  Object.defineProperty(view,'scrollHeight',{configurable:true,value:2000});Object.defineProperty(view,'clientHeight',{configurable:true,value:400});
  view.scrollTop=1750;view.dispatchEvent(new window.Event('scroll'));await settle();
  assert.equal(run('fullSessionReview.pages.at(-1).index'),1,'near-bottom scroll loads the next page');
  const retained=window.document.querySelector('[data-review-key="full:50"]');
  await run('loadFullReviewPage(2)');
  assert.equal(run('fullReviewItems()[0].queue_id'),51);assert.equal(window.document.querySelectorAll('#session-review-list img').length,100);
  assert.equal(window.document.querySelector('[data-review-key="full:50"]'),retained,'retained cards/pixels survive scrolling');
  assert.equal(oldImage.hasAttribute('src'),false,'evicted crop pixels are released');
  await run('loadFullReviewPage(3)');await run('loadFullReviewPage(4)');
  assert.ok(window.document.querySelectorAll('#session-review-list .card').length<=100);
  assert.equal(run('fullReviewItems().at(-1).queue_id'),240,'scrolling reaches the full corpus');
  // An edit/refresh keeps both loaded pages mounted until every replacement is available.
  const beforeRefresh=window.document.querySelector('[data-review-key="full:150"]');
  window.holdNextReviewFetch=true;
  const refreshing=run('refreshFullReviewWindow(fullSessionReview)');await tick();
  assert.equal(window.document.querySelectorAll('#session-review-list .card').length,90,'refresh never paints an empty loading grid');
  assert.equal(window.document.querySelector('[data-review-key="full:150"]'),beforeRefresh);
  window.releaseReviewFetch();await refreshing;
  assert.equal(run('fullSessionReview.pages.length'),2,'refresh retains the entire two-page window');
  assert.equal(run('fullReviewItems()[0].queue_id'),151);
  assert.equal(window.document.querySelector('[data-review-key="full:150"]'),beforeRefresh,'unchanged cards remain mounted through refresh');

  const persisted=JSON.parse(window.sessionStorage.getItem('collector:full-review-window'));
  assert.deepEqual(persisted.indexes,[3,4]);
  run('resetFullSessionReview();renderSessionReview()');await settle();
  assert.equal(run('fullSessionReview.pages.map(page=>page.index).join()'),'3,4','reload restores the loaded window rather than starting at page zero');
  assert.equal(run('fullReviewItems()[0].queue_id'),151);
  await run('loadFullReviewPage(2)');assert.equal(run('fullReviewItems()[0].queue_id'),101,'earlier pages reload after eviction');

  await setSearch('hold-old');assert.ok(holds.has('hold-old'));
  await setSearch('OldMarker');assert.equal(run('fullReviewItems()[0].queue_id'),1,'search reaches a crop outside the labeling buffer');
  assert.equal(holds.get('hold-old').signal.aborted,true);
  holds.get('hold-old').resolve({items:[rows[239]],next_cursor:null,total:1,review_stats:stats()});await settle();
  assert.equal(run('fullReviewItems()[0].queue_id'),1,'late search results cannot replace the current query');
  run("pool[0].label='Stale';reviewAwards={'full:239':{label:'Stale'}};fullSessionReview.editing='full:0';");
  assert.equal(await run("refreshAiReviewedRows({run_id:'run',corrected:1})"),false,'AI refresh defers while a manual draft is open');
  assert.equal(run('pool[0].label'),'Stale');
  run('fullSessionReview.editing=null;');
  assert.equal(await run("refreshAiReviewedRows({run_id:'run',corrected:1})"),true);
  assert.equal(run('pool[0].label'),'S 239 BB','AI refresh reconciles bounded retained rows with durable labels');
  assert.equal(run("reviewAwards['full:239'].label"),'S 239 BB');
  await setSearch('bad-response');
  assert.match(window.document.getElementById('review-page-status').textContent,/HTTP 404/);
  assert.ok(!window.document.getElementById('review-page-status').textContent.includes('Unexpected token'));
  window.document.getElementById('review-page-more').click();await settle();
  assert.equal(run('fullSessionReview.error'),'','readable error can be retried');

  window.document.getElementById('review-search').value='';window.document.getElementById('review-filter').value='blank';run('renderSessionReview()');await new Promise(resolve=>setTimeout(resolve,190));await settle();
  assert.ok(run("fullReviewItems().every(item=>item.reviewed && item.label==='')"));
  assert.equal(run('fullSessionReview.total'),rows.filter(r=>r.reviewed&&!r.discarded&&r.label==='').length,'filter counts the full durable session');
  window.document.getElementById('review-filter').value='all';await setSearch('OldMarker');
  run("startFullSessionEdit('full:0')");window.document.getElementById('edit-input-full-review-1').value='S No Chips';
  await run("saveFullSessionLabel('full:0')");
  assert.equal(rows[0].label,'S No Chips');assert.equal(run('pool.length'),1,'editing an evicted sample does not enlarge the labeling buffer');
  const reviewCall=calls.find(call=>call.url==='/api/review_label');assert.equal(reviewCall.body.queue_id,1);assert.equal(reviewCall.body.prediction_id,'prediction:0');
  assert.equal(run('sessionScore'),777,'grid correction does not award points');
  const savedQuery=JSON.parse(window.sessionStorage.getItem('collector:full-review-window'));
  assert.equal(savedQuery.search,'OldMarker');
  run('resetFullSessionReview(true)');
  assert.equal(window.sessionStorage.getItem('collector:full-review-window'),null,'actual departure clears the reload checkpoint');
  await setSearch('S No Chips');await run('removeFullSessionItems(fullReviewItems())');
  assert.equal(rows.some(row=>row.queue_id===1),false);assert.equal(run('fullReviewItems().length'),0);
  assert.deepEqual(calls.find(call=>call.url==='/api/queue/discard').body.sample_keys,['full:0']);
  assert.match(window.document.getElementById('review-page-status').textContent,/0–0 of 0/);

  await setSearch('S ');run('selectFullReviewShown()');
  assert.equal(run('fullReviewSelection().length'),50);
  const beforeBulk=calls.filter(call=>call.url==='/api/review_label').length;
  window.document.getElementById('review-bulk-label-input').value='S 99 BB';await run('bulkLabelFullSession()');
  assert.equal(calls.filter(call=>call.url==='/api/review_label').length-beforeBulk,50,'bulk writes are bounded to the shown selection');
  assert.equal(run('fullReviewSelection().length'),0);assert.equal(run('sessionScore'),777);
  await setSearch('S 239 BB');
  run("reviewAwards['full:239']={points:60,label:'S 239 BB',action:'accept'};pool[0].review_reward=reviewAwards['full:239'];startFullSessionEdit('full:239')");
  window.document.getElementById('edit-input-full-review-240').value='S 240 BB';await run("saveFullSessionLabel('full:239')");
  assert.equal(run('pool[0].label'),'S 240 BB','retained labeling row follows grid correction before checkpoint save');
  assert.equal(run("reviewAwards['full:239'].label"),'S 240 BB','persisted award receipt follows corrected truth without new points');
  await setSearch('S 240 BB');await run('removeFullSessionItems(fullReviewItems())');
  assert.equal(run('pool.length'),0,'deleting a retained row also removes it from the labeling checkpoint');
  assert.ok(!calls.some(call=>/\/commit(?:\?|$)/.test(call.url)),'review edits/deletes never implicitly commit the corpus');

  await setSearch('hold-dataset');assert.ok(holds.has('hold-dataset'));
  run("datasetEpoch++;activeDatasetId='other';reviewBatch={mode:'stream',batch_id:'other-run'};resetFullSessionReview();");
  window.document.getElementById('review-search').value='';run('renderSessionReview()');await settle();
  holds.get('hold-dataset').resolve({items:[rows[0]],next_cursor:null,total:1});await settle();
  assert.equal(run('fullSessionReview.datasetId'),'other');assert.equal(run('fullReviewItems().length'),0,'old dataset responses cannot populate the new review');
  assert.ok(calls.filter(call=>call.url.startsWith('/api/queue/review/items?')).every(call=>new URL(call.url,'http://localhost').searchParams.get('limit')==='50'));
  console.log('PASS: full durable-session scrolling/search/filter; <=100 cards; retained pixels, stable-key edits/deletes and provenance; stale-query/dataset isolation.');
}finally{run('resetFullSessionReview()');window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
