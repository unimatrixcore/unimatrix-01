// Actual client with a synthetic 250-crop stream and binary-pixel preload fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module'),uiRoot=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(uiRoot,'package.json'))('jsdom');
const dom=new JSDOM(fs.readFileSync('dev_tools/templates/poker_lab.html','utf8'),{url:'http://localhost/collection',runScripts:'outside-only'}),{window}=dom;
const rows=Array.from({length:250},(_,i)=>({queue_id:i+1,sample_key:'continuous:'+i,id:'seats[0].name',source:'capture.png',game_id:'#123456',image_url:'/api/queue/image/'+(i+1),reviewed:true,label:'Alice',labelTime:1000}));
const requests=[],revoked=[];let urls=0,decoded=0;
window.URL.createObjectURL=()=>`blob:fixture-${++urls}`;window.URL.revokeObjectURL=url=>revoked.push(url);
window.Image=class {decode(){decoded++;return Promise.resolve();}};
const summary={total:250,pending:0,reviewed:250,revision:1};
const stats={total:250,reviewed:250,pending:0,items:250,time:250000,complete:true};
window.fetch=async(url,options={})=>{
 requests.push({url,options});let data;
 if(url.startsWith('/api/queue/image/')) return{ok:true,blob:async()=>new window.Blob(['pixel'])};
 if(url==='/api/queue/review/start')data={session:{pool:rows.slice(0,11),currentReviewIdx:0,maxReachedIdx:0,review_batch:{mode:'stream',batch_id:'run',keys:rows.slice(0,11).map(r=>r.sample_key),next_cursor:'11',legacy_offset:0,total_at_start:250}},summary,review_stats:stats};
 else if(url.startsWith('/api/queue/review/next?')){const u=new URL(url,'http://localhost'),start=Number(u.searchParams.get('cursor')||0),limit=Number(u.searchParams.get('limit'));assert.ok(limit<=10);data={items:rows.slice(start,start+limit),next_cursor:start+limit<rows.length?String(start+limit):null,summary,review_stats:stats};}
 else if(url.startsWith('/api/queue/review/stats?'))data={summary,review_stats:stats};
 else if(url==='/api/save_session_progress'){const saved=JSON.parse(options.body);assert.ok(saved.pool.length<=61);assert.ok(saved.review_batch.keys.length<=61);data={success:true};}
 else throw new Error('Unexpected request '+url);
 return{ok:true,status:200,json:async()=>data};
};
window.matchMedia=()=>({matches:true});require('./helpers/browser.cjs')(window);window.eval(fs.readFileSync('dev_tools/static/ui/collector-ui.js','utf8'));
const context=dom.getInternalVMContext(),source=fs.readFileSync('dev_tools/static/js/app.js','utf8').replace('init().catch(error => { showLoading(false); showToast(error.message, "error"); });','').replace('const setView =','let setView =');
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../static/js/lib/list_cards.js'),'utf8'),context);vm.runInContext(source,context);const run=s=>vm.runInContext(s,context);
run(`activeDatasetId='fixture';queueMode=true;isRecovering=false;currentView='collection';
frameListEl=document.getElementById('frame-list');labelInput=document.getElementById('label-input');
usernamePool={getItems:()=>['KnownSavedName'],has:name=>name==='KnownSavedName',add(){},counts:{clear(){throw new Error('Name knowledge must survive crop eviction');}}};
showToast=(message,type)=>{if(type==='error')throw new Error(message);};updateStepperButtons=()=>{};renderDatasetNavigator=()=>{};
setView=view=>{currentView=view;};showLabelingStats=()=>{globalThis.completions=(globalThis.completions||0)+1;};`);
(async()=>{try{
 assert.equal(await run('loadReviewBatch()'),true);
 assert.equal(run('pool.length'),11);assert.equal(decoded,11,'current and next ten pixel blobs are decoded before entry');
 for(let index=1;index<250;index++){
  await run('advanceContinuousReview()');if(run('streamFetch'))await run('streamFetch');
  assert.equal(run('pool[currentReviewIdx].sample_key'),'continuous:'+index);
  assert.ok(run('pool.length')<=61,'browser window never exceeds last50/current/next10');
  assert.ok(run('maxReachedIdx')<=50);assert.ok(run('pool.length-1-maxReachedIdx')<=10);
  assert.ok(run('streamImages.size')<=61,'decoded pixel URLs are bounded with metadata');
  assert.equal(run('globalThis.completions||0'),0,'no completion interruption after100');
 }
 assert.equal(run('currentReviewIdx'),50);assert.equal(run('pool[0].sample_key'),'continuous:199');
 assert.equal(run('reviewBatch.legacy_offset'),199);
 assert.equal(run('pool.length'),51);assert.equal(run("usernamePool.has('KnownSavedName')"),true,'text-only autocomplete/discovery knowledge survives eviction');assert.ok(revoked.length>=199,'older crop object URLs are revoked');
 await run('advanceContinuousReview()');assert.equal(run('globalThis.completions'),1,'only the whole collection completes');
 assert.equal(requests.filter(r=>r.url.startsWith('/api/queue/image/')).length,250,'each crop pixel is fetched once and focus reuses its blob URL');
 assert.equal(run('cropImage(pool[currentReviewIdx]).startsWith("blob:")'),true);
 await run('saveSessionProgress(true)');
 const checkpoint=JSON.parse(requests.findLast(r=>r.url==='/api/save_session_progress').options.body);
 assert.equal(checkpoint.currentReviewIdx,50);assert.equal(checkpoint.review_batch.legacy_offset,199);
 run('resetQueueState()');assert.equal(run('streamImages.size'),0);assert.equal(revoked.length,urls,'all object URLs released on dataset reset');
 console.log('PASS: all250 crops flow continuously; next10 pixels preloaded, previous50 retained, no100stop, bounded checkpoints/cache and final-only completion.');
}finally{window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
