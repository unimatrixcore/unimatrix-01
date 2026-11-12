// Exercise keyboard containment against the actual shared-button collector DOM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const uiRoot = path.resolve(process.env.UNIMATRIX_UI_ROOT || path.join(os.homedir(), 'repositories/unimatrix-01/packages/ui'));
const { JSDOM } = createRequire(path.join(uiRoot, 'package.json'))('jsdom');
const dom = new JSDOM(fs.readFileSync('dev_tools/templates/poker_lab.html', 'utf8'), {runScripts:'outside-only',url:'http://localhost/collection'});
const {window} = dom;
const {document} = window;
require('./helpers/browser.cjs')(window);window.eval(fs.readFileSync('dev_tools/static/ui/collector-ui.js', 'utf8'));
window.eval(fs.readFileSync('dev_tools/static/js/lib/ui.js', 'utf8'));
const trigger = document.getElementById('dataset-create-open');
const cancel = document.getElementById('btn-modal-cancel');
const confirm = document.getElementById('btn-modal-confirm');
function key(name, shiftKey=false) {
  document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', {key:name,shiftKey,bubbles:true,cancelable:true}));
}
(async () => {
  trigger.focus();
  const first = window.showConfirmModal('Archive dataset', 'Keep all labels and history?');
  assert.equal(document.activeElement, cancel, 'confirmation starts on the safe action');
  key('Tab'); assert.equal(document.activeElement, confirm);
  key('Tab'); assert.equal(document.activeElement, cancel, 'Tab stays inside the modal');
  key('Tab', true); assert.equal(document.activeElement, confirm, 'Shift+Tab wraps');
  trigger.focus(); assert.equal(document.activeElement, cancel, 'background cannot take focus');
  key('Escape'); assert.equal(await first, false);
  assert.equal(document.activeElement, trigger, 'closing restores the initiating control');
  const second = window.showConfirmModal('Confirm', 'Save changes?');
  confirm.click(); assert.equal(await second, true);
  const replaced = window.showConfirmModal('Old dialog', 'Old message');
  const replacement = window.showConfirmModal('New dialog', 'New message');
  assert.equal(await replaced, false, 'replacing a dialog settles its pending promise');
  document.getElementById('modal-overlay').click();
  assert.equal(await replacement, false, 'backdrop cancels');
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-labelledby'), 'modal-title');
  dom.window.close();
  console.log('Collector dialog passed: focus containment, keyboard cancellation, safe initial focus, restoration and replacement.');
})().catch(error => {console.error(error);dom.window.close();process.exitCode=1;});
