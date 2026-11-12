// A bounded review window must not masquerade as completion of the collection.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createRequire}=require('node:module'),uiRoot=process.env.UNIMATRIX_UI_ROOT||path.join(os.homedir(),'repositories/unimatrix-01/packages/ui');
const {JSDOM}=createRequire(path.join(uiRoot,'package.json'))('jsdom');
const dom=new JSDOM('<div id="labeling-hud"></div><div id="labeling-stats-card"><div id="stats-badge-container"></div><div id="stats-container"></div><div id="high-score-entries"></div></div>',{runScripts:'outside-only'}),{window}=dom;
const calls=[];
Object.assign(window,{queueMode:true,queueSummary:{total:2500},queueCompletedStats:{items:100,time:100000},sessionScore:72045,currentCombo:12,maxCombo:12,quickLabels:50,autoCompletes:70,highscoreAdded:false,pool:[{label:'Alice',labelTime:2000},{label:'',reviewed:true,labelTime:1000}],globalHistory:[{score:100,items:5,rpm:20,timestamp:1}],getComboMultiplier:()=>3,updateScoreDisplay(){},saveSessionProgress(){},datasetFetch:async(url,opts)=>{calls.push({url,body:opts?.body&&JSON.parse(opts.body)});return{json:async()=>url.includes('get_session_history')?[]:{success:true}};}});
window.eval(fs.readFileSync('dev_tools/static/js/lib/stats.js','utf8'));
(async()=>{try {
 await window.showLabelingStats();
 assert.equal(window.sessionScore,72045);assert.equal(window.currentCombo,12);assert.equal(window.autoCompletes,70);
 assert.equal(calls.length,0,'partial batch cannot log full-session completion or rankings');
 assert.equal(window.document.getElementById('stats-badge-container').textContent,'','partial batch cannot claim a new full-session high score');
 assert.match(window.document.getElementById('stats-container').textContent,/Session Score/);
 assert.match(window.document.getElementById('stats-container').textContent,/Batch Labeled/);
 window.queueSummary={total:2};
 await window.showLabelingStats();
 const history=calls.find(call=>call.url==='/api/save_session_history');
 assert.equal(history.body.items,102,'actual completion includes earlier committed batches');
 assert.equal(history.body.score,72045);assert.equal(window.sessionScore,0,'only actual collection completion resets the game');
 assert.equal(window.queueCompletedStats.items,0);
 console.log('PASS: batch results retain points/combo and suppress premature completion; actual end records cumulative session metrics.');
}finally{window.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
