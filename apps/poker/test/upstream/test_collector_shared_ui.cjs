// Exercise the shipped collector bundle, including its real shared UI/helper imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const repoRoot = path.resolve(__dirname, '../..');
const uiRoot = path.resolve(process.env.UNIMATRIX_UI_ROOT || path.join(os.homedir(), 'repositories/unimatrix-01/packages/ui'));
const uiRequire = createRequire(path.join(uiRoot, 'package.json'));
const { JSDOM } = uiRequire('jsdom');
const template = fs.readFileSync(path.join(repoRoot, 'dev_tools/templates/poker_lab.html'), 'utf8');
const bundle = fs.readFileSync(path.join(repoRoot, 'dev_tools/static/ui/collector-ui.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'dev_tools/static/ui/collector-ui.css'), 'utf8');
const dom = new JSDOM(template, { runScripts: 'outside-only', url: 'http://localhost/collection' });
const { window } = dom;
const { document } = window;
const errors = [];
window.console.error = (...args) => errors.push(args.join(' '));
window.addEventListener('error', event => errors.push(event.message));

async function runIntegration() {
try {
  const initialIds = [...document.querySelectorAll('[id]')].map(node => node.id).sort();
  assert.equal(new Set(initialIds).size, initialIds.length, 'template IDs must be unique');
  const scripts = [...document.querySelectorAll('script[src]')];
  const sharedScript = scripts.find(script => script.getAttribute('src') === '/static/ui/collector-ui.js');
  const legacyScript = scripts.find(script => script.getAttribute('src') === '/static/js/app.js');
  assert.ok(sharedScript && legacyScript && scripts.indexOf(sharedScript) < scripts.indexOf(legacyScript));
  assert.ok(!sharedScript.async && !sharedScript.defer, 'shared controls/helpers must exist before legacy initialization');

  require('./helpers/browser.cjs')(window);window.eval(bundle);
  const mountedIds = [...document.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(mountedIds).size, mountedIds.length, 'shared shell IDs remain unique');
  for (const id of initialIds) assert.ok(document.getElementById(id), `shared shell preserves ${id}`);
  assert.ok(document.querySelector('#main-content #section-ocr-data'), 'actual ToolShell hosts the existing workflow');
  const toggle = document.querySelector('button[aria-label="Expand sections"]');
  const captureNode = document.getElementById('capture-once');
  const originalPath = window.location.pathname;
  toggle.click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(document.querySelector('#main-content').parentElement.inert || document.querySelector('[inert]'));
  assert.deepEqual([...document.querySelectorAll('nav[aria-label="Sections"] a')].map(a => a.textContent), ['OCR Data', 'Gameplay']);
  document.querySelector('nav[aria-label="Sections"] a').click();
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(window.location.pathname, originalPath, 'chrome navigation does not replace native workflow history');
  assert.equal(document.getElementById('capture-once'), captureNode, 'sidebar toggles preserve native controls and their handlers');
  const sourceTrigger = document.querySelector('#watch-settings [data-recording-source-trigger]');
  const sourceSelect = document.getElementById('monitor-select');
  const intervalSelect = document.getElementById('watch-interval');
  assert.ok(sourceTrigger, 'recording source uses the shared popup trigger');
  assert.ok(sourceSelect && intervalSelect, 'closed popup fields exist before native initialization');
  window.CollectorSharedUi.enhance();
  assert.equal(document.querySelector('#watch-settings [data-recording-source-trigger]'), sourceTrigger, 'native enhancement leaves the React popup trigger intact');
  window.CollectorSharedUi.setRecordingSourceOpen('watch-settings', true);
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(document.getElementById('monitor-select'), sourceSelect);
  assert.ok(sourceSelect.closest('[data-slot="popover-content"]'), 'source form is rendered inside the actual shared Popover');
  window.CollectorSharedUi.setRecordingSourceOpen('watch-settings', false);
  await new Promise(resolve => window.setTimeout(resolve, 0));
  assert.equal(document.getElementById('watch-interval'), intervalSelect, 'closing the popup retains native field identity and values');
  assert.equal(document.documentElement.dataset.collectorUi, '@unimatrix/ui');
  assert.equal(document.querySelector('aside.dataset-bar'), null, 'dataset controls remain compact in the header');
  assert.ok(document.querySelector('header #dataset-select'));
  assert.ok(document.querySelector('#workflow-panel.workspace-topbar .workspace-topbar-leading .stepper'), 'OCR navigation uses the common workspace header');
  assert.ok(document.querySelector('#workflow-panel .stepper-panel-actions #dataset-select[data-slot=\"native-select\"]'), 'header retains shared select primitive');

  for (const id of ['dataset-create-open', 'dataset-rename-open', 'model-use', 'model-accept', 'label-save', 'nav-collection', 'capture-once']) {
    assert.equal(document.getElementById(id).dataset.slot, 'button', `${id} uses the shared Button`);
  }
  assert.equal(document.getElementById('count-frames-pill').dataset.slot, 'badge');
  assert.equal(document.querySelector('#model-accept kbd').dataset.slot, 'kbd');
  assert.equal(document.querySelector('#capture-once kbd, #watch-start kbd, #watch-stop kbd'), null, 'Recording buttons omit redundant shortcut badges');
  assert.equal(document.querySelector('#record-key-hints kbd').dataset.slot, 'kbd', 'Recording shortcuts remain in the shared hint row');
  assert.ok(document.getElementById('model-accept').disabled);

  const game = document.getElementById('labeling-hud');
  const answer = document.getElementById('label-input');
  assert.ok(game.querySelector('.label-group-header #score-display'), 'original score remains above the typing input');
  assert.ok(game.querySelector('.label-group-header #timer-display'), 'original read timer remains beside the score');
  assert.ok(game.querySelector('.input-wrapper #ghost-text'), 'inline completion overlay stays aligned with the input');
  assert.ok(game.querySelector('.input-wrapper #combo-badge #combo-multiplier'), 'original floating combo badge remains beside the input');
  assert.ok(answer.closest('.input-wrapper'), 'shared Input stays inside the original typing wrapper');
  assert.equal(answer.dataset.slot, 'input', 'the game consumes the actual shared Input');
  assert.equal(document.documentElement.classList.contains('dark'), true, 'collector enables the same shared charcoal theme as the admin app');
  for (const id of ['model-use','model-accept','label-save']) {
    assert.ok(document.getElementById(id).closest('[hidden]'), `${id} is a keyboard action target, not an extra visible button`);
  }
  const gameKeys=game.querySelector('.shortcut-bar').textContent;
  for (const key of ['Enter','Esc','Ctrl+Enter','Alt+Tab']) assert.ok(gameKeys.includes(key), `${key} belongs to the original shortcut row`);
  assert.ok(!gameKeys.includes('Ctrl+Tab') && !gameKeys.includes('Ctrl+Space'), 'edit hint has one current shortcut');
  assert.ok(document.querySelector('#labeling-stats-card .highscore-list-container #high-score-entries'), 'session rankings remain in the original ending card');

  for (const id of ['watch-stop','btn-restore','btn-review-select-all','btn-db-back']) {
    const button=document.getElementById(id);
    assert.ok(button.classList.contains('hidden'),`${id} starts hidden`);
    assert.ok(button.classList.contains('inline-flex'),`${id} keeps the shared flex layout while hidden`);
    button.classList.remove('hidden');
    assert.ok(button.classList.contains('inline-flex'),`${id} reveals as an inline-flex button`);
    button.classList.add('hidden');
  }
  assert.equal(document.getElementById('btn-restore').getAttribute('onclick'), 'restoreCurrent()');
  let nativeClicks = 0;
  const use = document.getElementById('model-use');
  use.onclick = () => nativeClicks++;
  use.disabled = false;
  use.click();
  assert.equal(nativeClicks, 1, 'legacy click wiring works after a shared control becomes enabled');

  const saved = document.createElement('article');
  saved.innerHTML = '<section class="saved-model-assist" id="db-model-fixture.png"><p id="db-model-state-fixture.png"></p><p id="db-model-text-fixture.png"></p><p id="db-model-raw-fixture.png"></p><button id="db-model-use-fixture.png" disabled>Use</button><button id="db-model-accept-fixture.png" disabled>Accept</button><button id="db-model-retry-fixture.png">Suggest</button></section>';
  const savedClicks = { use: 0, accept: 0, retry: 0 };
  for (const action of Object.keys(savedClicks)) {
    saved.querySelector(`[id="db-model-${action}-fixture.png"]`).onclick = () => savedClicks[action]++;
  }
  let keyboardEvents = 0;
  saved.querySelector('section').onkeydown = () => keyboardEvents++;
  window.CollectorSharedUi.enhance(saved);
  assert.equal(saved.querySelector('section').dataset.sharedReview, 'true');
  assert.equal((saved.textContent.match(/Alt\+Tab/g)||[]).length,1,'saved editor shows the current edit shortcut once');
  assert.ok(!saved.textContent.includes('Ctrl+Space') && !saved.textContent.includes('Ctrl+Tab'),'saved editor has no obsolete edit hint');
  for (const action of Object.keys(savedClicks)) {
    const button = saved.querySelector(`[id="db-model-${action}-fixture.png"]`);
    if (action !== 'retry') assert.ok(button.disabled);
    button.disabled = false;
    button.click();
    assert.equal(savedClicks[action], 1, `saved ${action} callback survives its shared mount and later enabling`);
  }
  saved.querySelector('section').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  assert.equal(keyboardEvents, 1, 'saved review keyboard handler survives the shared mount');

  const card=document.createElement('article');
  card.innerHTML='<div class="collection-card-menu" data-region-id="seat.name" data-menu-label="Game #123456"><a href="/api/cap_image/source.png?dataset_id=fixture" target="_blank" rel="noopener">View capture</a><button class="btn-danger">Remove crop</button><button>Remove capture</button></div>';
  const nativeMenuButtons=[...card.querySelectorAll('button')];
  const menuActions={crop:0,capture:0};
  nativeMenuButtons[0].onclick=()=>menuActions.crop++;
  nativeMenuButtons[1].onclick=()=>menuActions.capture++;
  document.body.appendChild(card);
  window.CollectorSharedUi.enhance(card);
  const menuHost=card.querySelector('.collection-card-menu');
  const trigger=menuHost.querySelector('button');
  assert.equal(menuHost.dataset.sharedMenu,'true');
  assert.equal(trigger.dataset.slot,'button','overflow trigger is a real shared Button');
  assert.equal(trigger.getAttribute('aria-label'),'Crop actions for seat.name');
  assert.equal(menuHost.querySelectorAll('button').length,1,'native action buttons become one overflow trigger');
  const flushMenu=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>window.setTimeout(resolve,0));};
  const openMenu=async()=>{trigger.focus();trigger.dispatchEvent(new window.MouseEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));await flushMenu();};
  await openMenu();
  let popup=document.querySelector('[data-slot="dropdown-menu-content"]');
  assert.ok(popup,'shared menu opens');
  assert.ok(!card.contains(popup),'menu portal escapes card clipping');
  assert.ok(popup.textContent.includes('Game #123456'));
  const captureLink=popup.querySelector('a');
  assert.equal(captureLink.getAttribute('href'),'/api/cap_image/source.png?dataset_id=fixture');
  assert.equal(captureLink.target,'_blank');assert.equal(captureLink.rel,'noopener');
  const cropAction=[...popup.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent==='Remove crop');
  assert.equal(cropAction.dataset.variant,'destructive','crop removal uses the shared destructive item');
  cropAction.click();await flushMenu();
  assert.equal(menuActions.crop,1,'shared menu calls the existing native closure once');
  assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'),null,'select closes the portal');
  await openMenu();
  window.CollectorSharedUi.closeMenus();await flushMenu();
  assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'),null,'view close hides portalled menus without destroying the card');
  await openMenu();
  popup=document.querySelector('[data-slot="dropdown-menu-content"]');
  const captureAction=[...popup.querySelectorAll('[role="menuitem"]')].find(node=>node.textContent==='Remove capture');
  captureAction.click();await flushMenu();assert.equal(menuActions.capture,1);
  await openMenu();
  document.querySelector('[role="menu"]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await flushMenu();
  assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'),null,'Escape closes the shared menu');
  assert.equal(document.activeElement,trigger,'Escape returns focus to the overflow trigger');
  await openMenu();
  document.body.dispatchEvent(new window.MouseEvent('pointerdown',{button:0,bubbles:true,cancelable:true}));await flushMenu();
  assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'),null,'outside pointer closes the shared menu');
  await openMenu();
  window.CollectorSharedUi.disposeMenus(card);await flushMenu();
  assert.equal(document.querySelector('[data-slot="dropdown-menu-content"]'),null,'removing a crop disposes its open portal');
  assert.equal(menuHost.children.length,0,'disposing releases the native card menu React root');
  card.remove();

  const helpers = window.CollectorSharedUi.reviewGamification;
  assert.ok(helpers, 'shipped bundle exposes actual shared gamification helpers');
  const accepted = helpers.awardSample(helpers.createAwardLedger(), { sampleId: 'blank-crop', action: 'accept', label: '', suggestionText: '' });
  assert.equal(accepted.pointsAwarded, 10, 'explicit blank acceptance earns the configured acceptance reward');
  assert.equal(accepted.ledger.streak, 1);
  const duplicate = helpers.awardSample(accepted.ledger, { sampleId: 'blank-crop', action: 'save', label: 'corrected', suggestionText: '' });
  assert.equal(duplicate.pointsAwarded, 0, 'repeated reviews cannot award a sample twice');
  assert.equal(duplicate.ledger.points, accepted.ledger.points);
  const restoredLedger = helpers.restoreAwardLedger(helpers.snapshotAwardLedger(duplicate.ledger));
  const receipt = helpers.restoreSampleAward(restoredLedger, { sampleId: 'saved-after-snapshot-failure', points: 20 });
  assert.equal(receipt.ledger.points, 30);
  assert.equal(helpers.restoreSampleAward(receipt.ledger, { sampleId: 'saved-after-snapshot-failure', points: 20 }).pointsAwarded, 0);
  assert.equal(helpers.classifyReviewReward({ action: null, label: 'copied', suggestionText: 'copied' }), 0, 'copying is not a rewarded review');

  let clock = helpers.createReadClock(1000);
  clock = helpers.pauseReadClock(clock, 'editing', 1200);
  clock = helpers.pauseReadClock(clock, 'loading', 1300);
  clock = helpers.resumeReadClock(clock, 'loading', 5000);
  assert.equal(helpers.readClockElapsedMs(clock, 6000), 200, 'finishing a model request cannot resume an editing-paused clock');
  clock = helpers.restoreReadClock(helpers.snapshotReadClock(clock, 6000), 10000);
  assert.equal(helpers.readClockElapsedMs(clock, 10100), 200, 'reload keeps editing time excluded');
  clock = helpers.resumeReadClock(clock, 'editing', 10100);
  assert.equal(helpers.readClockElapsedMs(clock, 10400), 500);

  document.getElementById('score-display').textContent = '30 points';
  document.getElementById('timer-display').textContent = 'Editing paused · 1.0s';
  document.getElementById('combo-multiplier').textContent = '2 reviewed in a row';
  const status = document.getElementById('review-session-status').textContent;
  assert.equal((status.match(/points/g) || []).length, 1, 'native status updates replace the entire semantic field');
  assert.ok(status.includes('Editing paused · 1.0s'));
  assert.ok(!status.includes('Reading') && !status.includes('Read time'), 'paused text leaves no stale shared clock label');

  for (const [, asset] of css.matchAll(/url\((\/static\/ui\/assets\/[^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(repoRoot, 'dev_tools', asset)), `font asset is bundled: ${asset}`);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Collector shared UI integration passed: preserved DOM; shared portal card menu, native actions, Escape/outside/dispose; Alt+Tab hint; shared reward/clock helpers; local fonts; no React errors.');
} finally {
  window.close();
}
}
runIntegration().catch(error=>{console.error(error);process.exitCode=1;});
