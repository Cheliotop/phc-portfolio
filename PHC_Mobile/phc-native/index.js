/**
 * PHC Mobile Entry Point
 *
 * Safety wrapper for Hermes environment to prevent "property is not configurable" crashes.
 */

(function() {
  const originalDefineProperty = Object.defineProperty;
  Object.defineProperty = function(obj, prop, descriptor) {
    try {
      return originalDefineProperty(obj, prop, descriptor);
    } catch (e) {
      if (e instanceof TypeError && e.message.includes('not configurable')) {
        console.warn(`[PHC] Prevented crash: property "${prop}" is not configurable.`);
        return obj;
      }
      throw e;
    }
  };
})();

import './index.ts';
