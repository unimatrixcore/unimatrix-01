// Exercise the actual scroll lifecycle with clamping during async DOM replacement.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module');
const ui=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(ui,'package.json'))('jsdom');
const source=fs.readFileSync('dev_tools/static/js/lib/scroll_position.js','utf8');
function fixture(saved) {
  const dom=new JSDOM('<main id="main-content"><section id="view-database"><div>cards</div></section><section id="view-collection"></section></main>',{url:'http://localhost/database',runScripts:'outside-only'});
  const {window:w}=dom,region=w.document.getElementById('main-content');
  Object.defineProperty(region,'clientHeight',{value:600});
  if(saved) w.sessionStorage.setItem('collector:current-page-scroll:v1',saved);
  w.eval(source);w.CollectorScroll.start();
  return {dom,w,region,manager:w.CollectorScroll};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
(async()=>{
  const a=fixture();
  try {
    a.manager.navigate('database','one');
    a.region.scrollTop=1450;a.region.scrollLeft=12;a.region.dispatchEvent(new a.w.Event('scroll'));
    a.manager.remember('database','one',{page:3,search:'Alice'});
    assert.equal(a.w.document.getElementById('view-database').style.minHeight,'2050px','scroll has space before a render empties the list');
    a.region.replaceChildren(a.w.document.getElementById('view-database'));
    a.region.scrollTop=0;await tick();
    assert.equal(a.region.scrollTop,1450,'DOM replacement restores the position before a resulting scroll event');
    a.manager.navigate('database','one');assert.equal(a.region.scrollTop,1450,'same-page activation retains scroll');
    a.w.dispatchEvent(new a.w.Event('pagehide'));
    const b=fixture(a.w.sessionStorage.getItem('collector:current-page-scroll:v1'));
    try {
      assert.equal(b.manager.recall('database','one').page,3);
      b.manager.navigate('database','one');assert.equal(b.region.scrollTop,1450,'reload restores nested container scroll');
      assert.equal(b.region.scrollLeft,12);
      b.w.document.getElementById('view-database').replaceChildren();await tick();
      assert.equal(b.region.scrollTop,1450,'async empty/loading content retains position');
      b.region.scrollTop=900;b.manager.adopt();
      b.w.document.getElementById('view-database').append(b.w.document.createElement('div'));await tick();
      assert.equal(b.region.scrollTop,900,'virtualized pagination can explicitly adopt its anchor correction');
      b.manager.navigate('collection','one');assert.equal(b.region.scrollTop,0,'actual navigation may reset scroll');
      assert.equal(b.w.document.getElementById('view-database').style.minHeight,'');
      b.manager.navigate('database','one');assert.equal(b.region.scrollTop,0,'departing clears the old page position');
      b.region.scrollTop=400;b.region.dispatchEvent(new b.w.Event('scroll'));
      b.manager.navigate('database','two');assert.equal(b.region.scrollTop,0,'datasets never inherit another dataset scroll');
    } finally {b.dom.window.close();}
    console.log('PASS: DOM replacement, async loading, same-page activation, reload, horizontal scroll, navigation and dataset isolation.');
  } finally {a.dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
