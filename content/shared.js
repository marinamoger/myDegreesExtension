/**
 * MyDegrees Enhancer – Shared Feature Registry
 *
 * Each feature file calls window.MDE.registerFeature({ id, init }).
 * Then content.js calls window.MDE.initFeatures() to run them.
 *
 * Note: init() may be async in some features. This registry intentionally
 * does not await them, so all features start immediately and independently.
 */

window.MDE = window.MDE || {};
window.MDE.features = window.MDE.features || [];

/**
 * Register a feature module.
 * @param {{ id: string, init: Function }} feature
 */
window.MDE.registerFeature = function registerFeature(feature) {
  window.MDE.features.push(feature);
};

/**
 * Run all registered features.
 * Each init() is called in a try/catch so one feature can't break others.
 */
window.MDE.initFeatures = function initFeatures() {
  for (const f of window.MDE.features) {
    try {
      f.init();
    } catch (e) {
      // Intentionally silent in production.
      // For debugging:
      // console.log("[MDE] feature failed:", f?.id, e);
    }
  }
};
