// Browser APIs required by the actual shared shell in nonvisual JSDOM fixtures.
module.exports = function browserApis(window) {
  window.ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
};
