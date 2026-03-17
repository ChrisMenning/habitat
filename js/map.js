/**
 * map.js — MapLibre GL map initialisation and all map operations.
 *
 * Responsibilities:
 *   - Create and configure the MapLibre Map instance
 *   - Register / update / toggle GeoJSON layers
 *   - Manage the feature popup
 *   - Wire pointer interactions (click, cursor)
 *
 * This module has NO knowledge of the iNaturalist API or the DOM panel.
 * It receives plain GeoJSON features and pre-built HTML strings from callers.
 *
 * NOTE ON TILE WORKER ERRORS:
 *   The OpenFreeMap "liberty" base-map style contains numeric expressions over
 *   vector-tile properties that can be absent on some features (e.g. road rank,
 *   label priority). MapLibre 3.x silently coerces these nulls; MapLibre 4.x
 *   logs "Expected value to be of type number, but found null" to the console.
 *   These warnings come from the base style — not from our layers — and do not
 *   affect rendering. They cannot be suppressed without patching the style.
 *   All of our own paint expressions use `match` over string enums from config.js,
 *   which is null-safe by design.
 */

import { CENTER, FILL_COLOR_EXPR, STROKE_COLOR_EXPR } from './config.js';

/* global maplibregl */  // loaded via <script> tag before this ES module

/** @type {import('maplibre-gl').Map|null} */
let _map = null;

// ── Map lifecycle ─────────────────────────────────────────────────────────────

/**
 * Creates the MapLibre map, attaches it to the given container, and returns it.
 * Must be called exactly once before any other export in this module.
 *
 * @param {string} containerId - id of the HTML element to mount the map into
 * @returns {import('maplibre-gl').Map}
 */
export function initMap(containerId) {
  _map = new maplibregl.Map({
    container: containerId,
    style:     'https://tiles.openfreemap.org/styles/liberty',
    center:    CENTER,
    zoom:      11,
  });

  _map.addControl(new maplibregl.NavigationControl(),                'top-left');
  _map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

  return _map;
}

// ── Layer management ──────────────────────────────────────────────────────────

/**
 * Registers an empty GeoJSON source and a circle layer for one logical group.
 * Must be called inside (or after) the map 'load' event.
 *
 * Paint expressions use `match` over string enum properties (layer_id, est_key).
 * This is the only pattern safe across MapLibre's tile-worker postMessage
 * boundary. Storing colours as feature properties and using `['get', ...]`
 * causes "Expected number, found null" in the worker when a property is absent.
 *
 * @param {string}  id      - logical layer id (e.g. 'pollinators')
 * @param {boolean} visible - initial visibility
 */
export function registerLayer(id, visible) {
  _map.addSource(id, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  _map.addLayer({
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
 * Replaces all features in a registered GeoJSON source.
 *
 * @param {string}             id
 * @param {GeoJSON.Feature[]}  features
 */
export function setLayerFeatures(id, features) {
  _map.getSource(id)?.setData({ type: 'FeatureCollection', features });
}

/**
 * Shows or hides a registered layer.
 *
 * @param {string}  id
 * @param {boolean} visible
 */
export function setLayerVisibility(id, visible) {
  _map.setLayoutProperty(`points-${id}`, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Returns the MapLibre layer ids used for pointer hit-testing.
 *
 * @param {Array<{id: string}>} layers
 * @returns {string[]}
 */
export function getInteractiveLayerIds(layers) {
  return layers.map(l => `points-${l.id}`);
}

// ── Popup management ──────────────────────────────────────────────────────────

/** @type {import('maplibre-gl').Popup|null} */
let _activePopup = null;

/**
 * Opens a popup at the given location. Closes any previously open popup first.
 *
 * @param {import('maplibre-gl').LngLat} lngLat
 * @param {string}                       html   - pre-escaped HTML from ui.js
 */
export function showPopup(lngLat, html) {
  _activePopup?.remove();
  _activePopup = new maplibregl.Popup({ maxWidth: '240px', offset: 10 })
    .setLngLat(lngLat)
    .setHTML(html)
    .addTo(_map);
}

/** Closes the active popup if one is open. */
export function closePopup() {
  _activePopup?.remove();
  _activePopup = null;
}

// ── Pointer interactions ──────────────────────────────────────────────────────

/**
 * Wires click and hover-cursor handlers onto the given layer ids.
 *
 * @param {string[]} layerIds
 * @param {function(lngLat: import('maplibre-gl').LngLat, props: object): void} onFeatureClick
 */
export function wireInteractions(layerIds, onFeatureClick) {
  _map.on('click', e => {
    const features = _map.queryRenderedFeatures(e.point, { layers: layerIds });
    if (features.length) {
      onFeatureClick(e.lngLat, features[0].properties);
    }
  });

  for (const layerId of layerIds) {
    _map.on('mouseenter', layerId, () => { _map.getCanvas().style.cursor = 'pointer'; });
    _map.on('mouseleave', layerId, () => { _map.getCanvas().style.cursor = '';        });
  }
}
