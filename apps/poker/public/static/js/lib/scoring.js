// Game scoring remains in the collector. Visual feedback is supplied by the
// shared Unimatrix renderer, so other review tools can use the same effects.
let collectorGameEffects = null, collectorGameEffectsHost = null, collectorGameEffectsEpoch = null;
function clearGamificationEffects() {
  collectorGameEffects?.dispose();
  collectorGameEffects = null;
  collectorGameEffectsHost = null;
  collectorGameEffectsEpoch = null;
}
function getGameEffects() {
  const host = document.querySelector('.input-wrapper');
  const create = window.CollectorSharedUi?.createGamificationEffects;
  if (!host || !create) return null;
  const epoch = typeof datasetEpoch === 'undefined' ? null : datasetEpoch;
  if (host !== collectorGameEffectsHost || epoch !== collectorGameEffectsEpoch) clearGamificationEffects();
  if (!collectorGameEffects) {
    collectorGameEffects = create(host);
    collectorGameEffectsHost = host;
    collectorGameEffectsEpoch = epoch;
  }
  return collectorGameEffects;
}
function getDynamicScoreColor(points) {
  return window.CollectorSharedUi?.getGamificationFeedbackColor(points) || 'var(--primary)';
}
function showFloatingScore(points, type = null, metadata = null) {
  if (points === 0 && !type) return;
  getGameEffects()?.emit({points, kind:type || undefined, glyph:metadata?.char, multiplier:getComboMultiplier(currentCombo)});
}
window.addEventListener?.('pagehide', clearGamificationEffects);
