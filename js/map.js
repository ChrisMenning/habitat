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

/** Sources that were created with MapLibre GeoJSON clustering enabled. */
const _clusteredSources = new Set();

/** Area-marker sources that were created with clustering enabled. */
const _clusteredAreaMarkerSources = new Set();

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
    container:              containerId,
    style:                  'https://tiles.openfreemap.org/styles/liberty',
    center:                 CENTER,
    zoom:                   11,
    preserveDrawingBuffer:  true,   // required for canvas.toDataURL() in map export
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
 * Each SVG file from /svg/ is loaded, re-colored white, and registered with a
 * dark drop-shadow so icons stay legible over any colored circle background.
 *
 * Icon IDs registered:
 *   icon-hummingbird         – Pollinator Corridor site pins (biggest)
 *   icon-butterfly-detailed  – Monarch Waystation markers
 *   icon-park                – Homegrown National Park yard markers
 *   icon-biohazard           – PFAS chemical hazard sites
 *   icon-butterfly           – Pollinator sightings (iNat + GBIF)
 *   icon-flower              – Native plant sightings (iNat + GBIF)
 *   icon-flower-tulip        – Non-native plant sightings (iNat + GBIF)
 *   icon-crow                – eBird bird sightings
 *   icon-deer                – Other wildlife sightings
 *
 * @returns {Promise<void>}
 */
export async function registerSvgIcons() {
  const SIZE = 64;
  const ICON_MAP = [
    ['icon-hummingbird',        'hummingbird'],
    ['icon-butterfly-detailed', 'butterfly-with-detailed-wings'],
    ['icon-park',               'park'],
    ['icon-biohazard',          'biohazard'],
    ['icon-butterfly',          'butterfly'],
    ['icon-flower',             'flower'],
    ['icon-flower-tulip',       'flower-tulip'],
    ['icon-crow',               'crow-solid-full'],
    ['icon-deer',               'deer'],
  ];

  await Promise.all(ICON_MAP.map(async ([id, filename]) => {
    if (_map.hasImage(id)) return;
    try {
      const text   = await (await fetch(`/svg/${filename}.svg`)).text();
      const parser = new DOMParser();
      const doc    = parser.parseFromString(text, 'image/svg+xml');
      const svgEl  = doc.documentElement;

      // Ensure explicit pixel size — required for drawImage to have a known target
      svgEl.setAttribute('width',  String(SIZE));
      svgEl.setAttribute('height', String(SIZE));

      // Force everything white — handle all three ways SVGs can specify color:
      // 1. <style> blocks with CSS classes (e.g. .st0{fill:#000000})
      doc.querySelectorAll('style').forEach(el => el.remove());
      // 2. inline style="fill:#000000" attributes
      doc.querySelectorAll('[style]').forEach(el => {
        el.style.fill = 'white';
        if (el.style.stroke && el.style.stroke !== 'none') el.style.stroke = 'white';
      });
      // 3. explicit fill/stroke attributes
      svgEl.setAttribute('fill', 'white');
      doc.querySelectorAll('[fill]').forEach(el => {
        if (el.getAttribute('fill') !== 'none') el.setAttribute('fill', 'white');
      });
      doc.querySelectorAll('[stroke]').forEach(el => {
        if (el.getAttribute('stroke') !== 'none') el.setAttribute('stroke', 'white');
      });

      // Use a Blob URL so the browser renders the SVG path geometry into a
      // canvas via drawImage.  map.loadImage() is NOT used — it explicitly
      // rejects SVG MIME types.  We then extract ImageData (not the canvas
      // element) because addImage requires a concrete pixel buffer.
      const blob = new Blob(
        [new XMLSerializer().serializeToString(doc)],
        { type: 'image/svg+xml' }
      );
      const url = URL.createObjectURL(blob);

      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, SIZE, SIZE);
          URL.revokeObjectURL(url);
          // getImageData returns a concrete ImageData with explicit width/height/data
          // — this is what addImage requires; passing canvas itself is unreliable.
          const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
          if (!_map.hasImage(id)) _map.addImage(id, imageData, { pixelRatio: 2 });
          resolve();
        };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      });
    } catch (err) {
      console.warn(`registerSvgIcons: failed to load ${filename}.svg —`, err);
    }
  }));
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
 * @property {boolean}     [gbif=false]      True for GBIF historical backdrop (larger, translucent).
 * @property {number|null} [radius]          Circle radius in px — overrides the type default.
 * @property {number|null} [strokeWidth]     Stroke width in px — overrides the type default.
 * @property {number|null} [opacity]         Fill opacity — overrides the type default.
 * @property {string|null} [symbol]          SVG icon image id to overlay on the circle.
 * @property {number|null} [iconSize]        Icon size multiplier — overrides the default 0.55.
 * @property {boolean}     [cluster=false]   Enable MapLibre GeoJSON source clustering.
 * @property {string|null} [clusterColor]    Fill color for cluster aggregate circles.
 */

export function registerLayer(id, visible, {
  gbif         = false,
  radius       = null,
  strokeWidth  = null,
  opacity      = null,
  symbol       = null,
  iconSize     = null,
  cluster      = false,
  clusterColor = null,
} = {}) {
  _map.addSource(id, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    ...(cluster ? { cluster: true, clusterMaxZoom: 14, clusterRadius: 40 } : {}),
  });

  if (cluster) {
    _clusteredSources.add(id);

    // Cluster aggregate circle — radius grows with point count
    _map.addLayer({
      id:     `cluster-${id}`,
      type:   'circle',
      source: id,
      filter: ['has', 'point_count'],
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': [
          'step', ['coalesce', ['get', 'point_count'], 0],
          14,       // 2–9 points
          10, 18,   // 10–49 points
          50, 22,   // 50+ points
        ],
        'circle-color':        clusterColor ?? '#64748b',
        'circle-opacity':      0.88,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    });

    // Cluster count label
    _map.addLayer({
      id:     `cluster-label-${id}`,
      type:   'symbol',
      source: id,
      filter: ['has', 'point_count'],
      layout: {
        visibility:              visible ? 'visible' : 'none',
        'text-field':            ['get', 'point_count_abbreviated'],
        'text-font':             ['Noto Sans Bold'],
        'text-size':             12,
        'text-allow-overlap':    true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color':      '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.35)',
        'text-halo-width': 1,
      },
    });
  }

  // Design language:
  //   iNat observations  — small solid dots  (6 px, full opacity)
  //   GBIF historical    — larger halo blobs  (8 px, translucent)
  //   Hazard / special   — caller supplies radius via options
  const r  = radius      ?? (gbif ? 8    : 6);
  const sw = strokeWidth ?? (gbif ? 1    : 1.5);
  const op = opacity     ?? (gbif ? 0.40 : 0.92);

  // When clustering is on, the unclustered-point layer must exclude cluster aggregates
  const unclusteredFilter = cluster ? ['!', ['has', 'point_count']] : undefined;

  const pointLayer = {
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
  };
  if (unclusteredFilter) pointLayer.filter = unclusteredFilter;
  _map.addLayer(pointLayer);

  // SVG icon overlaid on unclustered points only.
  if (symbol) {
    const symbolLayer = {
      id:     `symbol-${id}`,
      type:   'symbol',
      source: id,
      layout: {
        visibility:              visible ? 'visible' : 'none',
        'icon-image':            symbol,
        'icon-size':             iconSize ?? 0.55,
        'icon-allow-overlap':    true,
        'icon-ignore-placement': true,
      },
    };
    if (unclusteredFilter) symbolLayer.filter = unclusteredFilter;
    _map.addLayer(symbolLayer);
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
  if (_clusteredSources.has(id)) {
    if (_map.getLayer(`cluster-${id}`))       _map.setLayoutProperty(`cluster-${id}`,       'visibility', vis);
    if (_map.getLayer(`cluster-label-${id}`)) _map.setLayoutProperty(`cluster-label-${id}`, 'visibility', vis);
  }
}

/**
 * Returns the MapLibre layer ids used for pointer hit-testing.
 * For layers with clustering enabled, the cluster aggregate layer is also included.
 *
 * @param {Array<{id: string}>} layers
 * @returns {string[]}
 */
export function getInteractiveLayerIds(layers) {
  const ids = [];
  for (const l of layers) {
    ids.push(`points-${l.id}`);
    if (_clusteredSources.has(l.id)) ids.push(`cluster-${l.id}`);
  }
  return ids;
}

/**
 * Zooms the map into a cluster to expand it.
 * Called when the user clicks a cluster aggregate circle.
 *
 * @param {string}            sourceId    - GeoJSON source id
 * @param {number}            clusterId   - cluster_id from feature properties
 * @param {[number, number]}  coordinates - [lng, lat] of the cluster centre
 */
export function zoomToCluster(sourceId, clusterId, coordinates) {
  const source = _map.getSource(sourceId);
  if (!source) return;
  source.getClusterExpansionZoom(clusterId, (err, zoom) => {
    if (err) return;
    _map.easeTo({ center: coordinates, zoom });
  });
}

/**
 * Returns the effective geographic node coordinates for a clustering-enabled
 * source at the current map zoom level.
 *
 * When the source is clustered at the current zoom, cluster aggregate centroids
 * are returned instead of individual point coordinates.  When fully expanded
 * (zoom ≥ clusterMaxZoom), individual point coordinates are returned.
 *
 * Handles both `registerLayer` sources (id) and `registerAreaMarkersLayer`
 * sources (area-markers-${id}).
 *
 * @param {string} id  — logical layer id (without any prefix)
 * @returns {[number, number][]|null}  null if id is not a clustered source
 */
export function getEffectiveClusteredCoords(id) {
  const sourceId = _clusteredSources.has(id)
    ? id
    : _clusteredAreaMarkerSources.has(id)
      ? `area-markers-${id}`
      : null;
  if (!sourceId) return null;

  const features = _map.querySourceFeatures(sourceId);
  const seen   = new Set();
  const coords = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const key = `${(+g.coordinates[0]).toFixed(6)},${(+g.coordinates[1]).toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coords.push(g.coordinates);
  }
  return coords;
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
export function registerAreaMarkersLayer(id, visible, color, outlineColor, icon = null, cluster = false) {
  _map.addSource(`area-markers-${id}`, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    ...(cluster ? { cluster: true, clusterMaxZoom: 14, clusterRadius: 40 } : {}),
  });

  if (cluster) {
    _clusteredAreaMarkerSources.add(id);

    // Cluster aggregate circle — same color as individual markers
    _map.addLayer({
      id:     `cluster-area-markers-${id}`,
      type:   'circle',
      source: `area-markers-${id}`,
      filter: ['has', 'point_count'],
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: {
        'circle-radius': [
          'step', ['coalesce', ['get', 'point_count'], 0],
          14,       // 2–9 points
          10, 18,   // 10–49 points
          50, 22,   // 50+ points
        ],
        'circle-color':        color,
        'circle-opacity':      0.88,
        'circle-stroke-color': outlineColor,
        'circle-stroke-width': 2.5,
      },
    });

    // Cluster count label
    _map.addLayer({
      id:     `cluster-label-area-markers-${id}`,
      type:   'symbol',
      source: `area-markers-${id}`,
      filter: ['has', 'point_count'],
      layout: {
        visibility:              visible ? 'visible' : 'none',
        'text-field':            ['get', 'point_count_abbreviated'],
        'text-font':             ['Noto Sans Bold'],
        'text-size':             12,
        'text-allow-overlap':    true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color':      '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.35)',
        'text-halo-width': 1,
      },
    });
  }

  const unclusteredFilter = cluster ? ['!', ['has', 'point_count']] : undefined;

  const circleLayer = {
    id:     `circle-markers-${id}`,
    type:   'circle',
    source: `area-markers-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':       12,
      'circle-color':        color,
      'circle-opacity':      0.95,
      'circle-stroke-color': outlineColor,
      'circle-stroke-width': 2.5,
    },
  };
  if (unclusteredFilter) circleLayer.filter = unclusteredFilter;
  _map.addLayer(circleLayer);

  const symbolLayer = {
    id:     `label-markers-${id}`,
    type:   'symbol',
    source: `area-markers-${id}`,
    layout: {
      visibility:    visible ? 'visible' : 'none',
      ...(icon ? {
        'icon-image':            icon,
        'icon-size':             0.68,
        'icon-allow-overlap':    true,
        'icon-ignore-placement': true,
        'icon-offset':           [0, 0],
      } : {}),
      'text-field':            ['get', 'name'],
      'text-font':             ['Noto Sans Regular'],
      'text-size':             11,
      'text-offset':           [0, icon ? 1.6 : 1.3],
      'text-anchor':           'top',
      // Allow text to overlap so it never pulls down the icon with it
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
      'text-optional':         true,
    },
    paint: {
      'text-color':      '#78350f',
      'text-halo-color': '#fffbeb',
      'text-halo-width': 1.5,
    },
  };
  if (unclusteredFilter) symbolLayer.filter = unclusteredFilter;
  _map.addLayer(symbolLayer);
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
    if (_clusteredAreaMarkerSources.has(id)) {
      if (_map.getLayer(`cluster-area-markers-${id}`))       _map.setLayoutProperty(`cluster-area-markers-${id}`,       'visibility', vis);
      if (_map.getLayer(`cluster-label-area-markers-${id}`)) _map.setLayoutProperty(`cluster-label-area-markers-${id}`, 'visibility', vis);
    }
  }
}

// ── Raster WMS layers ─────────────────────────────────────────────────────────

/**
 * Registers a WMS raster layer (e.g. NLCD, CDL) as a MapLibre raster source
 * and layer.  Must be called early in the layer stack (before vector layers)
 * so it renders beneath all polygon and point overlays.
 *
 * @param {string}  id         - logical layer id (no 'raster-' prefix needed)
 * @param {boolean} visible    - initial visibility
 * @param {string}  tileUrl    - WMS tile URL with {bbox-epsg-3857} placeholder
 * @param {string}  [attribution]
 */
export function registerRasterLayer(id, visible, tileUrl, attribution = '') {
  _map.addSource(`${id}-source`, {
    type:        'raster',
    tiles:       [tileUrl],
    tileSize:    256,
    attribution,
  });
  _map.addLayer({
    id:     `raster-${id}`,
    type:   'raster',
    source: `${id}-source`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint:  { 'raster-opacity': 0.65 },
  });
}

/**
 * Shows or hides a registered raster layer.
 *
 * @param {string}  id
 * @param {boolean} visible
 */
export function setRasterLayerVisibility(id, visible) {
  const layerId = `raster-${id}`;
  if (_map.getLayer(layerId)) {
    _map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }
}

// ── Heatmap layers ────────────────────────────────────────────────────────────

/**
 * Connectivity Mesh — lines connect habitat nodes within 2 km.
 *
 * Lines are colored by the node types they connect:
 *   same-type    — the type’s own color
 *   cross-type   — a blended midpoint between the two type colors
 *   corridor: #f59e0b (amber)  waystation: #8b5cf6 (violet)  hnp: #10b981 (emerald)
 *
 * Distance quality is shown through two visual channels:
 *   optimal  ≤300 m  — solid, thick (4px), full opacity  → clearly healthy
 *   fair   300–700 m — solid, medium (2.5px), reduced opacity
 *   weak  700–2000 m — dashed (rendered by a second layer), thin, low opacity → clearly problematic
 *
 * Two MapLibre layers share one GeoJSON source because line-dasharray is not
 * data-driven; the solid layer filters out weak lines, the dash layer shows only weak.
 *
 * @param {boolean} visible
 */
export function registerConnectivityMesh(visible) {
  // Two separate GeoJSON sources — one for solid lines (optimal+fair), one for
  // dashed weak lines.  Using two sources avoids filter: expressions in the
  // layers entirely, which sidesteps MapLibre tile-worker type-checking errors
  // that fire when filter expressions are evaluated against features mid-load.
  _map.addSource('connectivity-mesh', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addSource('connectivity-mesh-weak', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Color lookup by pair_type (same-type or cross-type blend)
  const pairColorExpr = [
    'match', ['coalesce', ['get', 'pair_type'], 'unknown'],
    'corridor-corridor',     '#f59e0b',  // amber
    'waystation-waystation', '#8b5cf6',  // violet
    'hnp-hnp',               '#10b981',  // emerald
    'corridor-waystation',   '#c07ad6',  // blend amber+violet → mauve
    'waystation-corridor',   '#c07ad6',
    'corridor-hnp',          '#84be6e',  // blend amber+emerald → sage
    'hnp-corridor',          '#84be6e',
    'waystation-hnp',        '#4db6b8',  // blend violet+emerald → teal
    'hnp-waystation',        '#4db6b8',
    /* fallback */ '#aaaaaa',
  ];

  // Layer 1: solid lines — optimal (4 px, 90%) and fair (2.5 px, 65%)
  _map.addLayer({
    id:     'connectivity-mesh-layer',
    type:   'line',
    source: 'connectivity-mesh',
    layout: {
      visibility: visible ? 'visible' : 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color':   pairColorExpr,
      'line-width':   ['match', ['coalesce', ['get', 'distance_tier'], 'fair'], 'optimal', 4, 2.5],
      'line-opacity': ['match', ['coalesce', ['get', 'distance_tier'], 'fair'], 'optimal', 0.90, 0.65],
      'line-blur':    0,
    },
  });

  // Layer 2: dashed lines — weak (700 m–2 km), problematic connections
  _map.addLayer({
    id:     'connectivity-mesh-weak-layer',
    type:   'line',
    source: 'connectivity-mesh-weak',
    layout: {
      visibility: visible ? 'visible' : 'none',
      'line-cap': 'butt',
      'line-join': 'round',
    },
    paint: {
      'line-dasharray': [4, 5],
      'line-color':     pairColorExpr,
      'line-width':     1.5,
      'line-opacity':   0.40,
      'line-blur':      0,
    },
  });
}

/**
 * Update the connectivity mesh from all active site-layer types.
 * Draws lines between any pair of nodes whose distance is ≤ 2 km.
 * Lines are classified into tiers stored on the feature:
 *   optimal  ≤ 300 m  — all native bee species
 *   fair   300–700 m  — bumble bees and large solitary bees
 *   weak  700–2000 m  — weak but ecologically relevant; shown dashed
 *
 * @param {GeoJSON.Feature[]} corridorFeatures
 * @param {GeoJSON.Feature[]} waystationFeatures
 * @param {GeoJSON.Feature[]} hnpFeatures
 * @param {Set<string>}       activeLayers  — which of the 3 types to include
 */
export function updateConnectivityMesh(corridorFeatures, waystationFeatures, hnpFeatures, activeLayers) {
  const solidSrc = _map.getSource('connectivity-mesh');
  const weakSrc  = _map.getSource('connectivity-mesh-weak');
  if (!solidSrc || !weakSrc) return;

  const MAX_DIST_KM = 2.0;

  function distKm(a, b) {
    const R = 6371;
    const d1 = (b[1] - a[1]) * Math.PI / 180;
    const d2 = (b[0] - a[0]) * Math.PI / 180;
    const x  = Math.sin(d1 / 2) ** 2 + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(d2 / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }

  function toCoord(f) {
    const g = f.geometry;
    if (g.type === 'Point') return g.coordinates;
    const ring = g.coordinates[0];
    return [ring.reduce((s, c) => s + c[0], 0) / ring.length, ring.reduce((s, c) => s + c[1], 0) / ring.length];
  }

  // Assemble nodes only from active site layers, tagged with their type
  const nodes = [];
  if (activeLayers.has('gbcc-corridor')) {
    for (const f of corridorFeatures)   nodes.push({ coord: toCoord(f), type: 'corridor' });
  }
  if (activeLayers.has('waystations')) {
    for (const f of waystationFeatures) nodes.push({ coord: toCoord(f), type: 'waystation' });
  }
  if (activeLayers.has('hnp')) {
    for (const f of hnpFeatures)        nodes.push({ coord: toCoord(f), type: 'hnp' });
  }

  const solid = [];
  const weak  = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = distKm(nodes[i].coord, nodes[j].coord);
      if (d <= MAX_DIST_KM) {
        const tier      = d <= 0.3 ? 'optimal' : d <= 0.7 ? 'fair' : 'weak';
        const pairType  = nodes[i].type === nodes[j].type
          ? `${nodes[i].type}-${nodes[i].type}`
          : `${nodes[i].type}-${nodes[j].type}`;
        const feat = {
          type:       'Feature',
          geometry:   { type: 'LineString', coordinates: [nodes[i].coord, nodes[j].coord] },
          properties: { distance_m: +(d * 1000).toFixed(1), distance_tier: tier, pair_type: pairType },
        };
        (tier === 'weak' ? weak : solid).push(feat);
      }
    }
  }

  solidSrc.setData({ type: 'FeatureCollection', features: solid });
  weakSrc.setData({ type: 'FeatureCollection', features: weak });
}

/**
 * Registers the pollinator access traffic heatmap.
 * Fed from corridor sites + waystations + HNP yards combined.
 *
 * @param {boolean} visible
 */
export function registerPollinatorTrafficHeatmap(visible) {
  _map.addSource('pollinator-traffic-heat', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addLayer({
    id:     'pollinator-traffic-heat-layer',
    type:   'heatmap',
    source: 'pollinator-traffic-heat',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'heatmap-weight':   1,
      // ~1 km geographic radius at Green Bay latitude:
      //   z10 → ~14 px   z14 → ~225 px (capped: use 220 so tiles stay crisp)
      'heatmap-radius':   ['interpolate', ['exponential', 2], ['zoom'], 10, 14, 14, 220],
      'heatmap-intensity': 0.8,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(251,191,36,0)',
        0.2,  'rgba(251,191,36,0.25)',
        0.5,  'rgba(245,158,11,0.55)',
        0.75, 'rgba(234,88,12,0.78)',
        1,    'rgba(255,220,80,1)',
      ],
      'heatmap-opacity': 0.60,
    },
  });
}

/**
 * Update the Pollinator Activity Heat Map from all sighting features
 * (iNat + GBIF + eBird combined).
 *
 * @param {GeoJSON.Feature[]} sightingFeatures  — all pollinator observation features
 */
export function updatePollinatorTrafficHeatmap(sightingFeatures) {
  const source = _map.getSource('pollinator-traffic-heat');
  if (!source) return;

  const features = sightingFeatures
    .filter(f => f?.geometry)
    .map(f => {
      const g = f.geometry;
      const coords = g.type === 'Point' ? g.coordinates : (() => {
        const ring = g.coordinates[0];
        return [ring.reduce((s, c) => s + c[0], 0) / ring.length,
                ring.reduce((s, c) => s + c[1], 0) / ring.length];
      })();
      return { type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} };
    });

  source.setData({ type: 'FeatureCollection', features });
}

// ── Expansion Opportunities layer ────────────────────────────────────────────

/**
 * Registers the Expansion Opportunities circle layer.
 * Features are colored by composite suitability tier:
 *   good (≥70)    — emerald green
 *   moderate (≥45) — amber
 *   poor (<45)    — red
 */
export function registerExpansionOpportunitiesLayer(visible) {
  _map.addSource('expansion-opportunities', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addLayer({
    id:     'points-expansion-opportunities',
    type:   'circle',
    source: 'expansion-opportunities',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':         9,
      'circle-color': [
        'match', ['coalesce', ['get', 'suitability'], 'moderate'],
        'good',     '#10b981',
        'moderate', '#f59e0b',
        'poor',     '#ef4444',
        '#6b7280',
      ],
      'circle-opacity':        0.82,
      'circle-stroke-color':   '#ffffff',
      'circle-stroke-width':   1.5,
      'circle-stroke-opacity': 0.5,
    },
  });
}

/** Replaces Expansion Opportunities source data. */
export function updateExpansionOpportunitiesLayer(geojson) {
  _map.getSource('expansion-opportunities')?.setData(
    geojson ?? { type: 'FeatureCollection', features: [] }
  );
}

// ── Problem Areas layer ───────────────────────────────────────────────────────

/**
 * Registers the Problem Areas circle layer.
 * Features are colored by severity:
 *   high   — red
 *   medium — amber
 *   low    — gray
 */
export function registerProblemAreasLayer(visible) {
  _map.addSource('problem-areas', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addLayer({
    id:     'points-problem-areas',
    type:   'circle',
    source: 'problem-areas',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'circle-radius':  10,
      'circle-color': [
        'match', ['coalesce', ['get', 'severity'], 'medium'],
        'high',   '#dc2626',
        'medium', '#d97706',
        'low',    '#6b7280',
        '#9ca3af',
      ],
      'circle-opacity':        0.78,
      'circle-stroke-color':   '#1a1a1a',
      'circle-stroke-width':   1.5,
      'circle-stroke-opacity': 0.4,
      'circle-blur':           0.1,
    },
  });
}

/** Replaces Problem Areas source data. */
export function updateProblemAreasLayer(geojson) {
  _map.getSource('problem-areas')?.setData(
    geojson ?? { type: 'FeatureCollection', features: [] }
  );
}

// ── Habitat Suitability heatmap ───────────────────────────────────────────────

/**
 * Registers the habitat suitability heatmap.
 * Each grid-point feature carries a `weight` property (0–1) computed by
 * computeSuitabilityPoints() in alerts.js.
 *
 * Color ramp: transparent → pale green → medium green → deep forest green.
 * High-weight (good suitability) areas render as rich green; sparse/polluted
 * areas fade to transparent.
 */
export function registerSuitabilityHeatmap(visible) {
  _map.addSource('suitability-heat', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addLayer({
    id:     'suitability-heat-layer',
    type:   'heatmap',
    source: 'suitability-heat',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'heatmap-weight':    ['interpolate', ['linear'], ['coalesce', ['get', 'weight'], 0], 0, 0, 1, 1],
      'heatmap-intensity': 1.2,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(0,0,0,0)',
        0.10, 'rgba(187,247,208,0.18)',
        0.30, 'rgba(74,222,128,0.42)',
        0.55, 'rgba(22,163,74,0.68)',
        0.75, 'rgba(20,83,45,0.86)',
        1.0,  'rgba(6,78,59,1.0)',
      ],
      'heatmap-radius': [
        'interpolate', ['exponential', 2], ['zoom'],
        8, 40, 10, 80, 12, 160, 14, 320,
      ],
      'heatmap-opacity': 0.70,
    },
  });
}

/** Replaces Suitability heatmap source data. */
export function updateSuitabilityHeatmap(geojson) {
  _map.getSource('suitability-heat')?.setData(
    geojson ?? { type: 'FeatureCollection', features: [] }
  );
}

export function setHeatmapVisibility(id, visible) {
  const vis = visible ? 'visible' : 'none';
  const layerId = `${id}-layer`;
  if (_map.getLayer(layerId)) _map.setLayoutProperty(layerId, 'visibility', vis);
  // connectivity-mesh has a second layer for weak (dashed) connections
  const weakId = `${id}-weak-layer`;
  if (_map.getLayer(weakId)) _map.setLayoutProperty(weakId, 'visibility', vis);
}

// ── CDL agricultural fringe heatmap ──────────────────────────────────────────

/**
 * Registers a heatmap layer visualising bee-dependent CDL crop pixels from
 * /api/cdl-fringe. Weight [0–1] on each point reflects pollination dependency.
 * Color ramp: transparent → pale yellow → amber → deep orange-red.
 */
export function registerCdlFringeHeatmap(visible) {
  _map.addSource('cdl-fringe-heat', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  _map.addLayer({
    id:     'cdl-fringe-heat-layer',
    type:   'heatmap',
    source: 'cdl-fringe-heat',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'heatmap-weight':    ['interpolate', ['linear'], ['coalesce', ['get', 'weight'], 0], 0, 0, 1, 1],
      'heatmap-intensity':  1.0,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(0,0,0,0)',
        0.15, 'rgba(255,237,74,0.25)',
        0.35, 'rgba(251,191,36,0.55)',
        0.55, 'rgba(245,158,11,0.80)',
        0.75, 'rgba(217,119,6,0.92)',
        1.0,  'rgba(154,52,18,1.0)',
      ],
      'heatmap-radius': [
        'interpolate', ['exponential', 2], ['zoom'],
        8, 8,  10, 22,  12, 55,  14, 130,
      ],
      'heatmap-opacity': 0.82,
    },
  });
}

/** Replaces the CDL fringe source data. */
export function updateCdlFringeHeatmap(geojson) {
  _map.getSource('cdl-fringe-heat')?.setData(
    geojson ?? { type: 'FeatureCollection', features: [] }
  );
}

// ── Bee species richness heatmap ─────────────────────────────────────────────

/**
 * Registers the bee species richness heatmap layer.
 *
 * Fed from all 6 bee family GBIF records, one HeatmapWeightPoint per
 * occurrence, so hotspots reflect areas with high documentation density —
 * a spatial proxy for bee species richness.
 *
 * Color ramp:  transparent → pale amber → honey-amber → deep amber → brown,
 * matching the amber color scheme used for the bees-records circle layer.
 *
 * @param {boolean} visible
 */
export function registerBeeRichnessHeatmap(visible) {
  _map.addSource('bees-richness', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  _map.addLayer({
    id:     'bees-richness-layer',
    type:   'heatmap',
    source: 'bees-richness',
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'heatmap-weight':    1,
      'heatmap-radius':    ['interpolate', ['exponential', 2], ['zoom'], 10, 16, 14, 240],
      'heatmap-intensity': 0.9,
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0,    'rgba(245,158,11,0)',
        0.15, 'rgba(245,158,11,0.25)',
        0.35, 'rgba(234,88,12,0.55)',
        0.60, 'rgba(217,119,6,0.82)',
        0.85, 'rgba(180,83,9,0.95)',
        1.0,  'rgba(120,53,15,1.0)',
      ],
      'heatmap-opacity': 0.72,
    },
  });
}

/**
 * Replaces the bee richness heatmap source data.
 * Accepts the same GeoJSON features array as bees-records.
 *
 * @param {GeoJSON.Feature[]} features
 */
export function updateBeeRichnessHeatmap(features) {
  _map.getSource('bees-richness')?.setData({
    type: 'FeatureCollection',
    features: (features ?? []).filter(f => f?.geometry),
  });
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
      if (_clusteredAreaMarkerSources.has(l.id)) ids.push(`cluster-area-markers-${l.id}`);
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

  // Enforce a minimum ~2 km bounding box so nearby / single-point alerts
  // don't zoom in so far that a site is off-screen.
  const MIN_SPREAD = 0.022; // ≈ 2.2 km at Green Bay latitudes
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

// ── Opacity controls ──────────────────────────────────────────────────────────

/**
 * Sets the opacity of a registered point (circle) layer.
 * Controls circle-opacity and circle-stroke-opacity together.
 *
 * @param {string} id      - logical layer id (no 'points-' prefix)
 * @param {number} opacity - 0..1
 */
export function setPointLayerOpacity(id, opacity) {
  const lid = `points-${id}`;
  if (!_map.getLayer(lid)) return;
  _map.setPaintProperty(lid, 'circle-opacity',        opacity);
  _map.setPaintProperty(lid, 'circle-stroke-opacity', opacity);
  const sid = `symbol-${id}`;
  if (_map.getLayer(sid)) {
    _map.setPaintProperty(sid, 'icon-opacity', opacity);
  }
  if (_clusteredSources.has(id)) {
    const cid = `cluster-${id}`;
    if (_map.getLayer(cid)) _map.setPaintProperty(cid, 'circle-opacity', opacity);
  }
}

/**
 * Sets the opacity of a registered polygon area layer (fill + outline).
 * Controls both sublayers simultaneously, maintaining existing relative ratio.
 *
 * @param {string} id      - logical layer id (no prefix)
 * @param {number} opacity - 0..1 (applied relative to the layer's base opacity)
 */
export function setAreaLayerOpacity(id, opacity) {
  const fillId    = `fill-${id}`;
  const outlineId = `outline-${id}`;
  if (_map.getLayer(fillId))    _map.setPaintProperty(fillId,    'fill-opacity',    opacity * 0.22);
  if (_map.getLayer(outlineId)) _map.setPaintProperty(outlineId, 'line-opacity',    opacity);
  if (_map.getLayer(`circle-markers-${id}`)) {
    _map.setPaintProperty(`circle-markers-${id}`, 'circle-opacity', opacity);
  }
}

/**
 * Sets the opacity of a registered raster layer.
 *
 * @param {string} id      - logical layer id (no 'raster-' prefix)
 * @param {number} opacity - 0..1
 */
export function setRasterOpacity(id, opacity) {
  const lid = `raster-${id}`;
  if (_map.getLayer(lid)) _map.setPaintProperty(lid, 'raster-opacity', opacity);
}

/**
 * Sets the opacity of a registered heatmap layer.
 * For heatmap layers only (corridor proximity, pollinator traffic, CDL fringe).
 *
 * @param {string} sourceId - the map source id (e.g. 'connectivity-mesh')
 * @param {number} opacity  - 0..1
 */
export function setHeatmapOpacity(sourceId, opacity) {
  const lid = `${sourceId}-layer`;
  if (_map.getLayer(lid)) _map.setPaintProperty(lid, 'heatmap-opacity', opacity);
}

/**
 * Exposes the underlying MapLibre map instance for advanced usage
 * (e.g. canvas export in export.js, camera in permalink.js).
 *
 * @returns {import('maplibre-gl').Map}
 */
export function getMap() { return _map; }

// ── Pesticide pressure choropleth ─────────────────────────────────────────────

/**
 * Registers a county-level pesticide pressure choropleth.
 *
 * Two redundant visual channels satisfy WCAG AA non-text contrast:
 *   • Fill color   — pale yellow (low) → red (critical)
 *   • Fill opacity — 0.15 (Low) → 0.42 (Critical)  — stepped not continuous
 * Band 3–4 counties additionally receive a dashed outline (third channel).
 *
 * Must be called before polygon area layers so it renders beneath them.
 *
 * @param {string}  id      - logical id (typically 'pesticide')
 * @param {boolean} visible - initial visibility
 */
export function registerPesticideLayer(id, visible) {
  _map.addSource(`pesticide-${id}`, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // Fill — color + stepped opacity (two independent WCAG visual channels)
  _map.addLayer({
    id:     `fill-pesticide-${id}`,
    type:   'fill',
    source: `pesticide-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'fill-color': [
        'match', ['coalesce', ['get', 'band'], 0],
        1, '#fef9c3',  // pale yellow  — Low
        2, '#fbbf24',  // amber        — Moderate
        3, '#f97316',  // orange       — High
        4, '#dc2626',  // red          — Critical
        '#cccccc',
      ],
      'fill-opacity': [
        'match', ['coalesce', ['get', 'band'], 0],
        1, 0.15,
        2, 0.22,
        3, 0.32,
        4, 0.42,
        0.10,
      ],
    },
  });

  // Solid county outline for all bands
  _map.addLayer({
    id:     `outline-pesticide-${id}`,
    type:   'line',
    source: `pesticide-${id}`,
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'line-color': [
        'match', ['coalesce', ['get', 'band'], 0],
        3, '#c2410c',
        4, '#991b1b',
        '#92400e',
      ],
      'line-width': 1.0,
    },
  });

  // Dashed overlay for band 3–4 only — WCAG redundant visual channel
  // (line-dasharray cannot be data-driven; a separate layer is the standard pattern)
  _map.addLayer({
    id:     `hatch-pesticide-${id}`,
    type:   'line',
    source: `pesticide-${id}`,
    filter: ['>=', ['coalesce', ['get', 'band'], 0], 3],
    layout: { visibility: visible ? 'visible' : 'none' },
    paint: {
      'line-color':     '#dc2626',
      'line-width':      2.0,
      'line-dasharray': [5, 4],
      'line-opacity':    0.65,
    },
  });
}

/**
 * Replaces features in the pesticide choropleth source.
 *
 * @param {string}                    id
 * @param {GeoJSON.FeatureCollection} geojson
 */
export function setPesticideFeatures(id, geojson) {
  _map.getSource(`pesticide-${id}`)?.setData(geojson);
}

/**
 * Shows or hides the three pesticide choropleth sub-layers.
 *
 * @param {string}  id
 * @param {boolean} visible
 */
export function setPesticideLayerVisibility(id, visible) {
  const vis = visible ? 'visible' : 'none';
  for (const prefix of ['fill-pesticide-', 'outline-pesticide-', 'hatch-pesticide-']) {
    const lid = `${prefix}${id}`;
    if (_map.getLayer(lid)) _map.setLayoutProperty(lid, 'visibility', vis);
  }
}

// ── Nesting habitat indicator badge layer ─────────────────────────────────────
//
// Two sub-layers share the `nesting-badges` GeoJSON source:
//   nesting-badge-circle  — filled circle, tinted by tier, offset to upper-right
//   nesting-badge-text    — white score number centred on the circle
//
// Only shown at zoom ≥ 13 (same as NLCD tiles become meaningful), and only
// when the caller has set visibility 'visible' (tied to NLCD active state).

const NESTING_MIN_ZOOM = 13;

/**
 * Registers the nesting badge source and two sub-layers.
 * Must be called after the map 'load' event fires.
 *
 * @param {boolean} visible
 */
export function registerNestingBadgeLayer(visible) {
  if (_map.getSource('nesting-badges')) return;

  _map.addSource('nesting-badges', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  const vis = visible ? 'visible' : 'none';

  // Tier → badge background color
  const tierColor = [
    'match', ['get', 'nesting_tier'],
    'good',     '#6b3a2a',
    'moderate', '#b58a5a',
    /* default: low */ '#9ca3af',
  ];

  // Badge background circle — circle-translate offsets it upper-right of the marker
  _map.addLayer({
    id:      'nesting-badge-circle',
    type:    'circle',
    source:  'nesting-badges',
    minzoom: NESTING_MIN_ZOOM,
    layout:  { visibility: vis },
    paint: {
      'circle-radius':        9,
      'circle-color':         tierColor,
      'circle-opacity':       0.96,
      'circle-stroke-color':  '#ffffff',
      'circle-stroke-width':  1.5,
      'circle-translate':     [13, -13],
      'circle-translate-anchor': 'viewport',
    },
  });

  // Score number text — text-offset aligns with circle-translate at text-size 9
  // (12/9 ≈ 1.33 ems → matches 13px circle-translate)
  _map.addLayer({
    id:      'nesting-badge-text',
    type:    'symbol',
    source:  'nesting-badges',
    minzoom: NESTING_MIN_ZOOM,
    layout: {
      visibility:              vis,
      'text-field':            ['to-string', ['get', 'nesting_score']],
      'text-font':             ['Noto Sans Bold'],
      'text-size':             9,
      'text-offset':           [1.44, -1.44],
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
    },
  });
}

/**
 * Replaces badge source data.
 * Features must carry `nesting_score` (number) and `nesting_tier` (string) properties.
 *
 * @param {GeoJSON.FeatureCollection} geojson
 */
export function setNestingBadgeFeatures(geojson) {
  const src = _map.getSource('nesting-badges');
  if (src) src.setData(geojson);
}

/**
 * Shows or hides both nesting badge sub-layers.
 * @param {boolean} visible
 */
export function setNestingBadgeVisibility(visible) {
  const vis = visible ? 'visible' : 'none';
  for (const id of ['nesting-badge-circle', 'nesting-badge-text']) {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', vis);
  }
}

// ── Parcel ownership layer ────────────────────────────────────────────────────
//
// Three sub-layers share the `parcels` GeoJSON source:
//   parcel-fill    — zoom-interpolated fill opacity (0 at z13 → 0.45 at z15)
//                    color driven by ownership class via MapLibre match expression
//   parcel-outline — line layer visible from zoom 12 so users get a structural cue
//                    before fills appear
//   parcel-label   — owner text centered on each parcel (zoom ≥ 15)
//                    label = municipality name title-cased (public parcels only)

import { OWNERSHIP_META } from './parcels.js';

const _OWNERSHIP_FILL_COLOR = [
  'match', ['get', 'own_class'],
  'city',          OWNERSHIP_META.city.color,
  'county',        OWNERSHIP_META.county.color,
  'state',         OWNERSHIP_META.state.color,
  'institutional', OWNERSHIP_META.institutional.color,
  /* private / default */ 'transparent',
];

/**
 * Registers the parcel fill and outline layers.
 * Must be called after the map 'load' event.
 *
 * @param {boolean} visible  initial visibility
 */
export function registerParcelLayer(visible) {
  if (_map.getSource('parcels')) return;

  _map.addSource('parcels', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  const vis = visible ? 'visible' : 'none';

  // Outline — appears one zoom level before fills to give a structural cue
  _map.addLayer({
    id:      'parcel-outline',
    type:    'line',
    source:  'parcels',
    minzoom: 12,
    layout:  { visibility: vis },
    paint: {
      'line-color':   '#64748b',
      'line-width':   [
        'interpolate', ['linear'], ['zoom'],
        12, 0.4,
        15, 1.2,
      ],
      'line-opacity': [
        'interpolate', ['linear'], ['zoom'],
        12, 0.0,
        13, 0.5,
        15, 0.75,
      ],
    },
  });

  // Fill — smooth reveal starting at zoom 13
  _map.addLayer({
    id:      'parcel-fill',
    type:    'fill',
    source:  'parcels',
    minzoom: 13,
    layout:  { visibility: vis },
    paint: {
      'fill-color':   _OWNERSHIP_FILL_COLOR,
      'fill-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0.0,
        15, 0.45,
      ],
    },
  }, 'parcel-outline');  // insert below outline so outline stays crisp

  // Labels — centered in each parcel; public = municipality, private = owner name
  _map.addLayer({
    id:      'parcel-label',
    type:    'symbol',
    source:  'parcels',
    minzoom: 15,
    layout: {
      visibility:             vis,
      'text-field':           ['get', 'own_label'],
      'text-font':            ['Noto Sans Regular'],
      'text-size':            [
        'interpolate', ['linear'], ['zoom'],
        15, 10,
        17, 13,
      ],
      'text-max-width':       8,
      'text-anchor':          'center',
      // Allow overlap so private parcel names aren't suppressed by collision
      'text-allow-overlap':   true,
      'text-ignore-placement':true,
    },
    paint: {
      'text-color':            ['get', 'own_text_color'],
      'text-halo-color':       'rgba(255,255,255,0.85)',
      'text-halo-width':       0.8,
      'text-opacity': [
        'interpolate', ['linear'], ['zoom'],
        15, 0,
        16, 1,
      ],
    },
  });
}

/**
 * Replaces parcel source data *and* stamps `own_class` onto each feature's
 * properties so the paint expression works.
 *
 * @param {GeoJSON.FeatureCollection} geojson
 * @param {function(object):string}   classifyFn — classifyOwnership from parcels.js
 */
export function setParcelFeatures(geojson, classifyFn) {
  const src = _map.getSource('parcels');
  if (!src) return;
  // Stamp own_class and own_label onto each feature so paint/layout
  // expressions can read them without touching the source data.
  const stamped = {
    ...geojson,
    features: geojson.features.map(f => {
      const cls   = classifyFn(f.properties ?? {});
      const meta  = OWNERSHIP_META[cls];
      // Only label publicly-owned parcels, using the ownership class display name.
      // Private parcels get an empty label so they are not annotated on the map.
      const label = cls !== 'private' ? (meta?.label ?? '') : '';
      return {
        ...f,
        properties: {
          ...(f.properties ?? {}),
          own_class:      cls,
          own_label:      label,
          own_text_color: meta?.textColor ?? '#fff',
        },
      };
    }),
  };
  src.setData(stamped);
}

/**
 * Shows or hides both parcel sub-layers.
 * @param {boolean} visible
 */
export function setParcelLayerVisibility(visible) {
  const vis = visible ? 'visible' : 'none';
  for (const id of ['parcel-fill', 'parcel-outline', 'parcel-label']) {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', vis);
  }
}

// ── Wikimedia Commons camera-marker layer ────────────────────────────────────

/**
 * Registers the Commons photo marker layer.
 * Features carry `title`, `thumburl`, `descurl`, `description`, `artist`,
 * `license` properties for use in click handlers / lightbox.
 *
 * @param {boolean} visible
 */
export function registerCommonsLayer(visible) {
  if (_map.getSource('commons-photos')) return;

  _map.addSource('commons-photos', {
    type:    'geojson',
    data:    { type: 'FeatureCollection', features: [] },
    cluster: false,
  });

  const vis = visible ? 'visible' : 'none';

  _map.addLayer({
    id:     'commons-photo-circle',
    type:   'circle',
    source: 'commons-photos',
    layout: { visibility: vis },
    paint: {
      'circle-radius':       7,
      'circle-color':        '#7c3aed',
      'circle-opacity':      0.85,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
    },
  });

  _map.addLayer({
    id:     'commons-photo-icon',
    type:   'symbol',
    source: 'commons-photos',
    layout: {
      visibility:              vis,
      'text-field':            '📷',
      'text-size':             11,
      'text-allow-overlap':    true,
      'text-ignore-placement': true,
    },
  });
}

/**
 * Replaces Commons photo source data.
 * Features must have Point geometry and appropriate properties.
 * @param {GeoJSON.FeatureCollection} geojson
 */
export function setCommonsFeatures(geojson) {
  const src = _map.getSource('commons-photos');
  if (src) src.setData(geojson);
}

/**
 * Shows or hides the Commons photo layers.
 * @param {boolean} visible
 */
export function setCommonsLayerVisibility(visible) {
  const vis = visible ? 'visible' : 'none';
  for (const id of ['commons-photo-circle', 'commons-photo-icon']) {
    if (_map.getLayer(id)) _map.setLayoutProperty(id, 'visibility', vis);
  }
}


