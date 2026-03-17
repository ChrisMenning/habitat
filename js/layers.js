/**
 * layers.js — SUPERSEDED by map.js.
 *
 * Layer management has been consolidated into map.js, which owns the map
 * instance and all operations on it. New code should import from map.js.
 *
 * This file re-exports map.js's layer functions so any existing imports
 * continue to work without modification.
 */

export {
  registerLayer,
  setLayerFeatures,
  setLayerVisibility,
  getInteractiveLayerIds,
} from './map.js';

// ---- everything below this line is kept only for reference ----
// eslint-disable-next-line no-unused-vars
import { FILL_COLOR_EXPR, STROKE_COLOR_EXPR } from './config.js';

/**
 * Registers a GeoJSON source and a circle layer for one logical group.
 * The source starts empty; call `setLayerFeatures` to populate it.
 *
 * Paint colors use MapLibre `match` expressions over string enum properties
 * (layer_id, est_key) — NOT over pre-computed hex values stored as properties.
 * This is the only approach that is safe across MapLibre 4.x's tile worker
 * postMessage boundary, which enforces strict types and rejects null where
 * a number or color is expected.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {string}  id      - logical layer id (e.g. 'pollinators')
 * @param {boolean} visible - initial visibility
 */
export function registerLayer(map, id, visible) {
  map.addSource(id, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id:     `points-${id}`,
    type:   'circle',
    source: id,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':       7,
      'circle-color':        FILL_COLOR_EXPR,
      'circle-opacity':      0.92,
      'circle-stroke-color': STROKE_COLOR_EXPR,
      'circle-stroke-width': 2,
    },
  });
}

/**
 * Replaces the data in a registered GeoJSON source.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {string}                    id       - logical layer id
 * @param {GeoJSON.Feature[]}         features
 */
export function setLayerFeatures(map, id, features) {
  map.getSource(id)?.setData({ type: 'FeatureCollection', features });
}

/**
 * Shows or hides a registered layer.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {string}  id
 * @param {boolean} visible
 */
export function setLayerVisibility(map, id, visible) {
  map.setLayoutProperty(`points-${id}`, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Returns the MapLibre layer ids that should respond to pointer events.
 * Used by app.js to wire click and hover handlers.
 *
 * @param {Array<{id: string}>} layers
 * @returns {string[]}
 */
export function getInteractiveLayerIds(layers) {
  return layers.map(l => `points-${l.id}`);
}
