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
 * Must be called inside (or after) the map 'load' event, before any
 * registerLayer / registerAreaMarkersLayer call that references these ids.
 *
 * Canvas is 64 × 64 px at pixelRatio 2 → 32 px logical.
 * At icon-size 0.7 the icon renders at ~22 px — sized to fill the 20–22 px
 * diameter circles used for corridor pins and waystation markers.
 */
export function registerVectorIcons() {
  const SIZE = 64;
  const s    = SIZE;

  const icons = {

    // Flower — used on Pollinator Corridor place markers
    'icon-hummingbird': ctx => {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      const cx = s * 0.5, cy = s * 0.5;
      // 4 rounded petals
      ctx.beginPath(); ctx.ellipse(cx,        cy - s*0.23, s*0.14, s*0.23, 0, 0, 2*Math.PI); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx,        cy + s*0.23, s*0.14, s*0.23, 0, 0, 2*Math.PI); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx - s*0.23, cy,        s*0.23, s*0.14, 0, 0, 2*Math.PI); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + s*0.23, cy,        s*0.23, s*0.14, 0, 0, 2*Math.PI); ctx.fill();
      // Centre circle
      ctx.beginPath(); ctx.arc(cx, cy, s * 0.14, 0, 2 * Math.PI); ctx.fill();
    },

    // Butterfly — used on Monarch Watch Waystation markers
    'icon-butterfly': ctx => {
      ctx.fillStyle   = 'rgba(255,255,255,0.95)';
      const cx = s * 0.5, cy = s * 0.47;
      // Upper left wing
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx - s*0.38, cy - s*0.34, cx - s*0.42, cy + s*0.06);
      ctx.quadraticCurveTo(cx - s*0.14, cy + s*0.02, cx, cy + s*0.1);
      ctx.closePath(); ctx.fill();
      // Upper right wing
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.quadraticCurveTo(cx + s*0.38, cy - s*0.34, cx + s*0.42, cy + s*0.06);
      ctx.quadraticCurveTo(cx + s*0.14, cy + s*0.02, cx, cy + s*0.1);
      ctx.closePath(); ctx.fill();
      // Lower left wing
      ctx.beginPath();
      ctx.moveTo(cx, cy + s*0.1);
      ctx.quadraticCurveTo(cx - s*0.26, cy + s*0.32, cx - s*0.18, cy + s*0.43);
      ctx.quadraticCurveTo(cx - s*0.06, cy + s*0.20, cx, cy + s*0.04);
      ctx.closePath(); ctx.fill();
      // Lower right wing
      ctx.beginPath();
      ctx.moveTo(cx, cy + s*0.1);
      ctx.quadraticCurveTo(cx + s*0.26, cy + s*0.32, cx + s*0.18, cy + s*0.43);
      ctx.quadraticCurveTo(cx + s*0.06, cy + s*0.20, cx, cy + s*0.04);
      ctx.closePath(); ctx.fill();
      // Body
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth   = s * 0.09;
      ctx.lineCap     = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, s * 0.17);
      ctx.lineTo(cx, s * 0.82);
      ctx.stroke();
    },
  };

  for (const [id, drawFn] of Object.entries(icons)) {
    const canvas  = document.createElement('canvas');
    canvas.width  = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    drawFn(ctx);
    const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
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

// ── Alert highlight overlay ───────────────────────────────────────────────────

const HIGHLIGHT_SOURCE      = 'alert-highlight';
const HIGHLIGHT_LINE_SOURCE = 'alert-highlight-lines';
const HIGHLIGHT_PULSE       = 'alert-highlight-pulse';
const HIGHLIGHT_CORE        = 'alert-highlight-core';
const HIGHLIGHT_ARROW       = 'alert-highlight-arrows';
const HIGHLIGHT_LINE_LAYER  = 'alert-highlight-line-layer';

/**
 * Colours (fill + stroke) for each alert level.
 *   warn        — red    (PFAS / danger)
 *   opportunity — amber  (expansion zones)
 *   positive    — emerald (connected nodes)
 *   info        — blue
 */
const HIGHLIGHT_COLORS = {
  warn:        { fill: '#ef4444', stroke: '#b91c1c' },
  opportunity: { fill: '#f59e0b', stroke: '#d97706' },
  positive:    { fill: '#22c55e', stroke: '#15803d' },
  info:        { fill: '#3b82f6', stroke: '#1d4ed8' },
};

/**
 * Returns true once the highlight source + layers have been added to the map.
 */
function _hlReady() {
  return !!_map.getSource(HIGHLIGHT_SOURCE);
}

/**
 * Registers a downward-pointing arrow as an SDF image so icon-color can tint
 * it per-feature at render time.  The tip of the arrow sits at the very bottom
 * of the canvas so that icon-anchor:'bottom' places it exactly on the target.
 */
function _registerArrowSdf() {
  if (_map.hasImage('hl-arrow-sdf')) return;
  const SIZE = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const mx = SIZE * 0.5;
  ctx.fillStyle = '#ffffff';
  // Shaft
  ctx.beginPath();
  ctx.rect(mx - SIZE * 0.13, SIZE * 0.04, SIZE * 0.26, SIZE * 0.48);
  ctx.fill();
  // Arrowhead
  ctx.beginPath();
  ctx.moveTo(mx - SIZE * 0.38, SIZE * 0.50);
  ctx.lineTo(mx + SIZE * 0.38, SIZE * 0.50);
  ctx.lineTo(mx,               SIZE * 0.97);
  ctx.closePath();
  ctx.fill();
  _map.addImage('hl-arrow-sdf', ctx.getImageData(0, 0, SIZE, SIZE),
    { pixelRatio: 2, sdf: true });
}

/**
 * Lazily creates all highlight sources and layers on first use.
 * Order: line first (bottom), then pulse + core circles, then arrow symbols (top).
 */
function _ensureHighlightLayers() {
  if (_hlReady()) return;

  _registerArrowSdf();

  // ── Point circles source ───────────────────────────────────────────────────
  _map.addSource(HIGHLIGHT_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // ── Connecting line source ─────────────────────────────────────────────────
  _map.addSource(HIGHLIGHT_LINE_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // White halo so the dashed line reads against any basemap
  _map.addLayer({
    id:     `${HIGHLIGHT_LINE_LAYER}-halo`,
    type:   'line',
    source: HIGHLIGHT_LINE_SOURCE,
    paint: {
      'line-color':     '#ffffff',
      'line-width':     5,
      'line-opacity':   0.55,
      'line-dasharray': [2, 4],
    },
  });

  // Red dashed line
  _map.addLayer({
    id:     HIGHLIGHT_LINE_LAYER,
    type:   'line',
    source: HIGHLIGHT_LINE_SOURCE,
    paint: {
      'line-color':     '#ef4444',
      'line-width':     2.5,
      'line-opacity':   0.92,
      'line-dasharray': [4, 4],
    },
  });

  // Outer pulse ring
  _map.addLayer({
    id:     HIGHLIGHT_PULSE,
    type:   'circle',
    source: HIGHLIGHT_SOURCE,
    paint: {
      'circle-radius':       ['interpolate', ['linear'], ['zoom'], 8, 18, 14, 28],
      'circle-color':        ['coalesce', ['get', 'fill'], '#ef4444'],
      'circle-opacity':      0.25,
      'circle-stroke-color': ['coalesce', ['get', 'stroke'], '#b91c1c'],
      'circle-stroke-width': 2,
    },
  });

  // Inner solid dot
  _map.addLayer({
    id:     HIGHLIGHT_CORE,
    type:   'circle',
    source: HIGHLIGHT_SOURCE,
    paint: {
      'circle-radius':       ['interpolate', ['linear'], ['zoom'], 8, 8, 14, 12],
      'circle-color':        ['coalesce', ['get', 'fill'], '#ef4444'],
      'circle-opacity':      0.92,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  // Downward arrow icon above each highlighted point (SDF → tinted per level)
  _map.addLayer({
    id:     HIGHLIGHT_ARROW,
    type:   'symbol',
    source: HIGHLIGHT_SOURCE,
    layout: {
      'icon-image':            'hl-arrow-sdf',
      'icon-anchor':           'bottom',
      'icon-size':             ['interpolate', ['linear'], ['zoom'], 8, 0.55, 14, 0.75],
      // Lift the arrow so the tip clears the pulse ring.
      'icon-offset':           [0, -18],
      'icon-allow-overlap':    true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-color':       ['coalesce', ['get', 'fill'], '#ef4444'],
      'icon-halo-color':  'rgba(255,255,255,0.9)',
      'icon-halo-width':  1.5,
    },
  });
}

/** Interval id for the pulse animation. */
let _pulseTimer = null;

/**
 * Plots highlight circles + arrows for an alert and flies the camera to
 * encompass them.  For 'warn' level alerts a dashed red connecting line is also
 * drawn from the first coord (hazard site) to each subsequent coord (habitat sites).
 *
 * @param {Array<[number,number]>} coords  — [lng, lat] points to highlight
 * @param {'warn'|'opportunity'|'positive'|'info'} level
 */
export function showAlertHighlight(coords, level = 'warn') {
  if (!_map || !coords.length) return;
  _ensureHighlightLayers();

  const { fill, stroke } = HIGHLIGHT_COLORS[level] ?? HIGHLIGHT_COLORS.warn;

  // Circle + arrow features at each highlighted coordinate
  const pointFeatures = coords.map(([lng, lat]) => ({
    type: 'Feature',
    geometry:   { type: 'Point', coordinates: [lng, lat] },
    properties: { fill, stroke },
  }));
  _map.getSource(HIGHLIGHT_SOURCE).setData({
    type: 'FeatureCollection', features: pointFeatures,
  });

  // Connecting lines — only for warn (PFAS → habitat site pairs)
  if (level === 'warn' && coords.length >= 2) {
    // Draw one line from the hazard point (index 0) to each habitat site
    const lineFeatures = coords.slice(1).map(dest => ({
      type: 'Feature',
      geometry:   { type: 'LineString', coordinates: [coords[0], dest] },
      properties: {},
    }));
    _map.getSource(HIGHLIGHT_LINE_SOURCE).setData({
      type: 'FeatureCollection', features: lineFeatures,
    });
  } else {
    _map.getSource(HIGHLIGHT_LINE_SOURCE).setData(
      { type: 'FeatureCollection', features: [] }
    );
  }

  // Animate the outer ring opacity to create a pulse effect
  clearInterval(_pulseTimer);
  let t = 0;
  _pulseTimer = setInterval(() => {
    if (!_hlReady()) return clearInterval(_pulseTimer);
    t += 0.07;
    const opacity = 0.15 + 0.2 * (0.5 + 0.5 * Math.sin(t));
    _map.setPaintProperty(HIGHLIGHT_PULSE, 'circle-opacity', opacity);
  }, 50);
}

/**
 * Removes all highlight circles, arrows and lines; stops the pulse animation.
 */
export function clearAlertHighlight() {
  clearInterval(_pulseTimer);
  _pulseTimer = null;
  if (!_hlReady()) return;
  const empty = { type: 'FeatureCollection', features: [] };
  _map.getSource(HIGHLIGHT_SOURCE).setData(empty);
  _map.getSource(HIGHLIGHT_LINE_SOURCE).setData(empty);
}

/**
 * Flies the camera to a bounding box that contains all given [lng, lat] coords.
 * A minimum geographic spread is enforced so that two very-close points (< 1 km)
 * still show enough context — both sites will always be visible.
 *
 * @param {Array<[number,number]>} coords
 * @param {object} [opts]
 * @param {number} [opts.padding=80]   Pixel padding around the bounding box.
 * @param {number} [opts.maxZoom=15]   Max zoom level to apply.
 */
export function fitToCoords(coords, { padding = 80, maxZoom = 15 } = {}) {
  if (!coords.length) return;

  const lngs = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);

  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const midLng = (minLng + maxLng) / 2;
  const midLat = (minLat + maxLat) / 2;

  // Enforce a minimum ~1.2 km bounding box so nearby / single-point alerts
  // don't zoom in so far that a site is off-screen.
  const MIN_SPREAD = 0.011; // ≈ 1.1 km at Green Bay latitudes
  const spreadLng = Math.max(maxLng - minLng, MIN_SPREAD);
  const spreadLat = Math.max(maxLat - minLat, MIN_SPREAD);

  _map.fitBounds(
    [
      [midLng - spreadLng / 2, midLat - spreadLat / 2],
      [midLng + spreadLng / 2, midLat + spreadLat / 2],
    ],
    { padding, maxZoom, speed: 1.4 },
  );
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
      onFeatureClick(e.lngLat, features[0].properties, features[0]);
    }
  });

  for (const layerId of layerIds) {
    _map.on('mouseenter', layerId, () => { _map.getCanvas().style.cursor = 'pointer'; });
    _map.on('mouseleave', layerId, () => { _map.getCanvas().style.cursor = '';        });
  }
}
