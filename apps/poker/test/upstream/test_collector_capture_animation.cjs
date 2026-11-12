// Test real DOM cleanup/Stop handling plus image-space geometry without capturing
// a monitor or writing labels. Layout boxes and Web Animations are controlled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createRequire} = require('node:module');
const uiRoot = path.resolve(process.env.UNIMATRIX_UI_ROOT || path.join(os.homedir(),'repositories/unimatrix-01/packages/ui'));
const {JSDOM} = createRequire(path.join(uiRoot,'package.json'))('jsdom');
const template = fs.readFileSync('dev_tools/templates/poker_lab.html','utf8');
const source = fs.readFileSync('dev_tools/static/js/lib/capture_animation.js','utf8');
const dom = new JSDOM(template,{url:'http://localhost/collection',runScripts:'outside-only',pretendToBeVisual:true});
const {window} = dom;
const {document} = window;
require('./helpers/browser.cjs')(window);window.eval(fs.readFileSync('dev_tools/static/ui/collector-ui.js','utf8'));
let reduced = false, holdImage = false, holdFlights = false, imageRequests = 0;
const animations = [];
window.matchMedia = () => ({matches:reduced});
window.Image = function () {
  const image = document.createElement('img');
  Object.defineProperties(image,{naturalWidth:{value:1920},naturalHeight:{value:1080},complete:{value:false},src:{
    get(){return image.getAttribute('src') || '';},
    set(value){imageRequests++;image.setAttribute('src',value);if(!holdImage)window.setTimeout(()=>{if(value.includes('fail'))image.onerror?.();else image.onload?.();},0);},
  }});
  image.getBoundingClientRect = () => ({left:100,top:100,width:1000,height:600});
  return image;
};
window.Element.prototype.animate = function (frames,options) {
  animations.push({className:this.className,frames,options});
  return {finished:holdFlights && this.className === 'capture-arrival-crop' ? new Promise(()=>{}) : Promise.resolve(),cancel(){}};
};
window.eval(source);
const api = window.CollectorCaptureAnimation;
const stop = document.getElementById('watch-stop');
stop.classList.remove('hidden');stop.disabled=false;
const stopHost = stop.parentElement;
const originalParent = stopHost.parentElement;
const target = document.createElement('article');
const targetImage = document.createElement('img');target.appendChild(targetImage);document.body.appendChild(target);
targetImage.getBoundingClientRect = () => ({left:24,top:180,width:280,height:120});
const region = {sample_key:'crop-a',id:'seat.name',rect:{x:192,y:108,w:384,h:216},base64_image:'ZmFrZQ=='};
const frame = {image_url:'/frame.png',frame_width:1920,frame_height:1080,game_id:'#123456',source:'watch_frame.png'};
const payload = () => ({frame,regions:[region],targets:[{sampleKey:'crop-a',element:target}],isCurrent:()=>true});
async function until(predicate) {
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Expected animation stage did not appear');
}
(async()=>{
  const projected=api.projectRegion(1920,1080,{left:10,top:20,width:1000,height:1000},region.rect);
  for (const [key,value] of Object.entries({left:110,top:295,width:200,height:112.5})) assert.ok(Math.abs(projected[key]-value)<1e-8,'ROI projection includes object-fit letterboxing');
  assert.equal(api.projectRegion(1920,1080,{left:0,top:0,width:100,height:100},{x:1910,y:0,w:20,h:10}),null,'clipped ROIs cannot animate with false geometry');
  assert.equal((await api.present({...payload(),regions:[]})).shown,false);
  assert.equal(imageRequests,0,'discarded/duplicate batches do not even load a preview');

  let stops=0;
  stop.onclick=()=>{stops++;api.cancel();};
  holdFlights=true;
  const cancelled=api.present(payload());
  await until(()=>targetImage.style.visibility === 'hidden');
  assert.equal(document.querySelector('.capture-arrival-controls'),null,'capture panel has no relocated recording controls');
  assert.equal(stopHost.parentElement,originalParent,'Stop stays in its original toolbar during the capture');
  assert.equal(document.querySelector('.capture-arrival').contains(stop),false,'capture panel sits above the existing toolbar');
  assert.equal(targetImage.style.visibility,'hidden');
  stop.click();
  assert.equal(stops,1,'original Stop retains its native action');
  assert.equal(document.querySelector('.capture-arrival'),null,'Stop clears panel synchronously');
  await cancelled;
  assert.equal(stopHost.parentElement,originalParent,'Stop is never moved from its toolbar');
  assert.equal(targetImage.style.visibility,'','cancel restores destination pixels');
  holdFlights=false;

  animations.length=0;
  let prepared=0;
  const completed=await api.present({...payload(),prepareTargets:()=>{prepared++;assert.ok(animations.some(a=>a.className==='capture-arrival-flash'),'cards insert after capture flash');return payload().targets;}});
  assert.equal(completed.shown,true);
  assert.equal(prepared,1,'new cards are inserted once at flight start');
  assert.ok(animations.some(a=>a.className==='capture-arrival-flash'&&a.options.duration===150));
  assert.ok(animations.some(a=>a.className==='capture-arrival-crop'&&a.frames[1].transform.includes('translate(')),'actual crop flies from ROI to card');
  assert.equal(document.querySelectorAll('.capture-arrival,.capture-arrival-crop').length,0);
  assert.equal(targetImage.style.visibility,'');

  reduced=true;animations.length=0;
  assert.equal((await api.present(payload())).reducedMotion,true);
  assert.equal(animations.length,0,'reduced motion has no flash or crop flights');
  reduced=false;holdImage=true;
  const loading=api.present(payload());api.cancel();await loading;
  assert.equal(document.querySelector('.capture-arrival'),null,'Stop also cancels image loading');
  holdImage=false;
  assert.equal((await api.present({...payload(),frame:{...frame,image_url:'/fail.png'}})).shown,false);
  assert.equal(document.querySelector('.capture-arrival'),null,'image failure leaves no dimming or hidden targets');
  assert.equal((await api.present({...payload(),isCurrent:()=>false})).shown,false,'stale dataset never opens panel');
  dom.window.close();
  console.log('Capture animation passed: letterboxing, admitted-only preview, crop flight, stationary Stop control, cancellation, cleanup, image failure, stale scope and reduced motion.');
})().catch(error=>{console.error(error);api.cancel();dom.window.close();process.exitCode=1;});
