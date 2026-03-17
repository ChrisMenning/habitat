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

// ── Emoji image sprites ──────────────────────────────────────────────────────

/**
 * Draws emoji glyphs onto off-screen canvases and registers them as MapLibre
 * image sprites so they can be referenced by `icon-image` in symbol layers.
 *
 * Must be called inside (or after) the map 'load' event.
 *
 * @param {Record<string, string>} imageMap  - { imageId: '🔭' } pairs
 * @param {number} [size=24]                 - canvas dimension in px
 */
export function registerEmojiImages(imageMap, size = 24) {
  for (const [id, emoji] of Object.entries(imageMap)) {
    const canvas  = document.createElement('canvas');
    canvas.width  = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.font        = `${size * 0.8}px serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    ctx.clearRect(0, 0, size, size);
    ctx.fillText(emoji, size / 2, size / 2);
    const imgData = ctx.getImageData(0, 0, size, size);
    if (!_map.hasImage(id)) {
      _map.addImage(id, imgData, { pixelRatio: 2 });
    }
  }
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
/**
 * @typedef {Object} LayerStyleOptions
 * @property {boolean}     [gbif=false]    True for GBIF historical backdrop (larger, translucent).
 * @property {number|null} [radius]        Circle radius in px — overrides the type default.
 * @property {number|null} [strokeWidth]   Stroke width in px — overrides the type default.
 * @property {number|null} [opacity]       Fill opacity — overrides the type default.
 * @property {string|null} [symbol]        Unicode character rendered as a centred symbol overlay.
 */

export function registerLayer(id, visible, {
  gbif        = false,
  radius      = null,
  strokeWidth = null,
  opacity     = null,
  symbol      = null,
} = {}) {
  _map.addSource(id, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Design language:
  //   iNat observations  — small solid dots  (6 px, full opacity)
  //   GBIF historical    — larger halo blobs  (8 px, translucent)
  //   Hazard / special   — caller supplies radius via options
  const r  = radius      ?? (gbif ? 8    : 6);
  const sw = strokeWidth ?? (gbif ? 1    : 1.5);
  const op = opacity     ?? (gbif ? 0.40 : 0.92);

  _map.addLayer({
    id:     `points-${id}`,
    type:   'circle',
    source: id,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':       r,
      'circle-color':        FILL_COLOR_EXPR,
      'circle-opacity':      op,
      'circle-stroke-color': STROKE_COLOR_EXPR,
      'circle-stroke-width': sw,
    },
  });

  // Optional emoji icon overlaid on the circle.
  // Registered via registerEmojiImages() before layer creation.
  if (symbol) {
    _map.addLayer({
      id:     `symbol-${id}`,
      type:   'symbol',
      source: id,
      layout: {
        visibility:              visible ? 'visible' : 'none',
        'icon-image':            symbol,
        'icon-size':             0.7,
        'icon-allow-overlap':    true,
        'icon-ignore-placement': true,
      },
    });
  }
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
  const vis = visible ? 'visible' : 'none';
  _map.setLayoutProperty(`points-${id}`, 'visibility', vis);
  if (_map.getLayer(`symbol-${id}`)) {
    _map.setLayoutProperty(`symbol-${id}`, 'visibility', vis);
  }
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

// ── Polygon area layers ───────────────────────────────────────────────────────

/**
 * Registers a polygon area layer (fill + outline) for one dataset.
 * Area layers are added BEFORE point layers so they appear underneath.
 *
 * @param {string}  id           - logical layer id (e.g. 'padus')
 * @param {boolean} visible      - initial visibility
 * @param {string}  fillColor    - CSS color for the polygon fill
 * @param {string}  outlineColor - CSS color for the polygon outline
 */
export function registerAreaLayer(id, visible, fillColor, outlineColor) {
  _map.addSource(`area-${id}`, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  _map.addLayer({
    id:     `fill-${id}`,
    type:   'fill',
    source: `area-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'fill-color':   fillColor,
      'fill-opacity': 0.22,
    },
  });

  _map.addLayer({
    id:     `outline-${id}`,
    type:   'line',
    source: `area-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'line-color': outlineColor,
      'line-width': 1.5,
    },
  });
}

/**
 * Replaces all features in a registered polygon area source.
 *
 * @param {string}                    id
 * @param {GeoJSON.FeatureCollection} geojson
 */
export function setAreaFeatures(id, geojson) {
  _map.getSource(`area-${id}`)?.setData(geojson);
}

/**
 * Registers a circle + text-label marker layer for a polygon area layer.
 * Markers sit above the polygon fill so small areas remain visible when
 * zoomed out.  Centroid GeoJSON is supplied separately via setAreaMarkersFeatures.
 * Must be called after the corresponding registerAreaLayer call.
 *
 * @param {string}  id           - same logical id as the area layer
 * @param {boolean} visible      - initial visibility (should match the area layer)
 * @param {string}  color        - fill colour for the circle
 * @param {string}  outlineColor - stroke colour for the circle
 * @param {string}  [icon]       - emoji image id (registered via registerEmojiImages) to overlay
 */
export function registerAreaMarkersLayer(id, visible, color, outlineColor, icon = null) {
  _map.addSource(`area-markers-${id}`, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  _map.addLayer({
    id:     `circle-markers-${id}`,
    type:   'circle',
    source: `area-markers-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':       10,
      'circle-color':        color,
      'circle-opacity':      0.95,
      'circle-stroke-color': outlineColor,
      'circle-stroke-width': 2,
    },
  });

  _map.addLayer({
    id:     `label-markers-${id}`,
    type:   'symbol',
    source: `area-markers-${id}`,
    layout: {
      visibility:    visible ? 'visible' : 'none',
      ...(icon ? {
        'icon-image':            icon,
        'icon-size':             0.7,
        'icon-allow-overlap':    true,
        'icon-ignore-placement': true,
        'icon-offset':           [0, 0],
      } : {}),
      'text-field':  ['get', 'name'],
      'text-font':   ['Noto Sans Regular'],
      'text-size':   11,
      'text-offset': [0, icon ? 1.5 : 1.3],
      'text-anchor': 'top',
    },
    paint: {
      'text-color':      '#78350f',
      'text-halo-color': '#fffbeb',
      'text-halo-width': 1.5,
    },
  });
}

/**
 * Replaces all features in a registered marker layer source.
 *
 * @param {string}                    id
 * @param {GeoJSON.FeatureCollection} geojson - Point FeatureCollection
 */
export function setAreaMarkersFeatures(id, geojson) {
  _map.getSource(`area-markers-${id}`)?.setData(geojson);
}

/**
 * Shows or hides a polygon area layer (both fill and outline sublayers).
 *
 * @param {string}  id
 * @param {boolean} visible
 */
export function setAreaVisibility(id, visible) {
  const vis = visible ? 'visible' : 'none';
  _map.setLayoutProperty(`fill-${id}`,    'visibility', vis);
  _map.setLayoutProperty(`outline-${id}`, 'visibility', vis);
  // Also toggle marker layers when present (e.g. gbcc-corridor)
  if (_map.getLayer(`circle-markers-${id}`)) {
    _map.setLayoutProperty(`circle-markers-${id}`, 'visibility', vis);
    _map.setLayoutProperty(`label-markers-${id}`,  'visibility', vis);
  }
}

/**
 * Returns the fill layer ids used for pointer hit-testing on area layers.
 * The fill layer covers the polygon interior and is the natural click target.
 *
 * @param {Array<{id: string}>} layers
 * @returns {string[]}
 */
export function getInteractiveAreaLayerIds(layers) {
  const ids = [];
  for (const l of layers) {
    ids.push(`fill-${l.id}`);
    // Include circle marker layer if one was registered for this area layer
    if (_map.getLayer(`circle-markers-${l.id}`)) {
      ids.push(`circle-markers-${l.id}`);
    }
  }
  return ids;
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
