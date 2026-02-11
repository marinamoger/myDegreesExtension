// Simple registry for independent features
window.MDE = window.MDE || {};
window.MDE.features = window.MDE.features || [];

/**
 * Register a feature.
 * @param {{ id: string, init: Function }} feature
 */
window.MDE.registerFeature = function registerFeature(feature) {
  window.MDE.features.push(feature);
};

/**
 * Run all registered features.
 */
window.MDE.initFeatures = function initFeatures() {
  for (const f of window.MDE.features) {
    try {
      f.init();
    } catch (e) {
      // during dev you can console.log(e)
    }
  }
};
