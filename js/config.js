/**
 * config.js — Application-wide constants and data definitions.
 *
 * All layer/establishment data lives here so other modules never hard-code
 * labels or colors, and so tests can import this without side-effects.
 */

/** Center of the map [lng, lat] */
export const CENTER = [-88.0133, 44.5133]; // Green Bay, WI

/** Search radius passed to the iNaturalist API */
export const RADIUS_KM = 15;

/**
 * iNaturalist place_id for Wisconsin.
 * Providing this causes the API to resolve taxon.establishment_means
 * relative to Wisconsin (native / introduced / invasive etc.).
 */
export const WI_PLACE_ID = 59;

export const PER_PAGE  = 200;
/**
 * Hard cap on total iNaturalist observations fetched per query.
 * iNat requests are serial (cursor-based), so each batch of 200 = 1 request.
 */
export const MAX_OBS      = 2000;
/**
 * Hard cap on GBIF occurrences fetched per layer per query.
 */
export const GBIF_MAX_OBS = 600;

// ── Layer definitions ────────────────────────────────────────────────────────

/**
 * The four logical display groups.
 * Each becomes an independent GeoJSON source + circle layer on the map.
 *
 * @type {Array<{id: string, label: string, emoji: string, description: string, defaultOn: boolean}>}
 */
export const LAYERS = [
  {
    id:          'pollinators',
    label:       'Pollinators',
    emoji:       '🦋',
    description: 'Bees, butterflies, moths, hoverflies & hummingbirds',
    defaultOn:   true,
  },
  {
    id:          'native-plants',
    label:       'Native Plants',
    emoji:       '🌸',
    description: 'Native & endemic plant species',
    defaultOn:   false,
  },
  {
    id:          'other-plants',
    label:       'Other Plants',
    emoji:       '🌷',
    description: 'Introduced, invasive & unconfirmed plants',
    defaultOn:   false,
  },
  {
    id:          'other-wildlife',
    label:       'Wildlife',
    emoji:       '🦌',
    description: 'Birds, mammals, non-pollinator insects, fungi & more',
    defaultOn:   false,
  },
];

/**
 * GBIF (Global Biodiversity Information Facility) data layers.
 * Rendered beneath iNaturalist layers so current observations appear on top.
 * GBIF provides historical depth: museum specimens, herbarium records, and
 * multi-source research datasets dating back decades.
 *
 * @type {Array<{id: string, label: string, emoji: string, description: string, defaultOn: boolean}>}
 */
export const GBIF_LAYERS = [

  {
    id:          'gbif-pollinators',
    label:       'Pollinators',
    emoji:       '🦋',
    description: 'Butterflies, moths & bees from museums and research surveys',
    defaultOn:   true,
  },
  {
    id:          'gbif-native-plants',
    label:       'Native Plants',
    emoji:       '🌸',
    description: 'Native & endemic plant records from herbaria and surveys',
    defaultOn:   false,
  },
  {
    id:          'gbif-non-native-plants',
    label:       'Non-Native Plants',
    emoji:       '🌷',
    description: 'Introduced, naturalised & invasive plant records',
    defaultOn:   false,
  },
];

// ── Protected area polygon layers ────────────────────────────────────────────

/**
 * Polygon layers sourced from USGS PAD-US and Wisconsin DNR.
 * These are rendered as filled polygons beneath all point layers.
 *
 * Each entry also carries `fillColor` and `outlineColor` paint values
 * used directly in maplibre-gl layer paint objects (not shared expressions,
 * since every area layer has its own distinct color).
 *
 * @type {Array<{id:string, label:string, emoji:string, description:string, defaultOn:boolean, fillColor:string, outlineColor:string}>}
 */
export const AREA_LAYERS = [
  {
    id:           'padus',
    label:        'Protected Areas',
    emoji:        '🛡️',
    description:  'USGS PAD-US v3.0 · federal, state, local & tribal protected lands',
    defaultOn:    false,
    fillColor:    '#16a34a',
    outlineColor: '#15803d',
  },
  {
    id:           'dnr-sna',
    label:        'State Natural Areas',
    emoji:        '🌳',
    description:  'WI DNR State Natural Areas · preserved natural communities',
    defaultOn:    true,
    fillColor:    '#0891b2',
    outlineColor: '#0e7490',
  },
  {
    id:           'dnr-managed',
    label:        'DNR Managed Lands',
    emoji:        '🏕️',
    description:  'WI DNR managed properties · wildlife areas, forests & parks',
    defaultOn:    false,
    fillColor:    '#7c3aed',
    outlineColor: '#6d28d9',
  },
  {
    id:           'gbcc-corridor',
    label:        'Pollinator Corridor',
    emoji:        '🌺',
    description:  'NE Wisconsin Pollinator Corridor · mapped planting areas (Green Bay Conservation Corps)',
    defaultOn:    true,
    fillColor:    '#f59e0b',
    outlineColor: '#d97706',
  },
  {
    id:           'gbcc-treatment',
    label:        'Habitat Treatments',
    emoji:        '🌱',
    description:  'GBCC restoration sites · invasive removal & re-planting treatments',
    defaultOn:    false,
    fillColor:    '#a3e635',
    outlineColor: '#65a30d',
  },
];

/**
 * Hazard point layers — rendered as circles on top of polygon area layers
 * but below iNat/GBIF sighting circles.
 *
 * @type {Array<{id:string, label:string, emoji:string, description:string, defaultOn:boolean}>}
 */
/**
 * Monarch Waystation point layer — rendered as circles above polygon layers.
 * Data is static (baked into waystations.js) so no API call is needed.
 *
 * @type {Array<{id:string, label:string, emoji:string, description:string, defaultOn:boolean}>}
 */
export const WAYSTATION_LAYER = [
  {
    id:          'waystations',
    label:       'Monarch Waystations',
    emoji:       '🦋',
    description: 'Monarch Watch certified waystation habitats (locations confirmed via Brown County parcel records)',
    defaultOn:   true,
  },
];

export const HNP_LAYER = [
  {
    id:          'hnp',
    label:       'Homegrown National Park',
    emoji:       '🌿',
    description: 'Registered native plant yards contributing to local biodiversity (Homegrown National Park)',
    defaultOn:   true,
  },
];

/**
 * Returns a relative tile URL served by the local dev server's NLCD proxy.
 * The proxy fetches the full NLCD WMS tile and filters pixels server-side,
 * returning only the requested land-cover class as a transparent PNG.
 *
 * @param {number} code  - NLCD pixel value (e.g. 11 for Open Water)
 * @returns {string}
 */
function nlcdClassTileUrl(code) {
  return `/api/nlcd-tile/${code}/{z}/{x}/{y}`;
}

/**
 * NLCD 2021 individual land-cover class layers.
 *
 * Each entry maps to one of the 16 official NLCD classes and produces a
 * separate raster tile layer showing only that class (others transparent).
 * Classes are grouped by semantic category for panel display.
 *
 * Official colors/values from: https://www.mrlc.gov/data/legends/national-land-cover-database-class-legend-and-description
 *
 * @type {Array<{id:string, label:string, emoji:string, description:string,
 *               defaultOn:boolean, color:string, nlcdCode:number, group:string,
 *               tileUrl:string, attribution:string}>}
 */
export const NLCD_LAYERS = [
  // ── Water ──────────────────────────────────────────────────────────────
  { code: 11, group: 'Water',       emoji: '💧', color: '#476ba1', label: 'Open Water',
    description: 'Streams, lakes, ponds, reservoirs, and estuaries' },
  { code: 12, group: 'Water',       emoji: '🧊', color: '#d1defa', label: 'Perennial Ice/Snow',
    description: 'Permanent snow and ice — minimal in Wisconsin' },
  // ── Developed ──────────────────────────────────────────────────────────
  { code: 21, group: 'Developed',   emoji: '🌿', color: '#ddc9c9', label: 'Developed · Open Space',
    description: 'Lawns, parks, golf courses — impervious surface < 20%' },
  { code: 22, group: 'Developed',   emoji: '🏚', color: '#d89382', label: 'Developed · Low Intensity',
    description: 'Residential — 20–49% impervious surface' },
  { code: 23, group: 'Developed',   emoji: '🏗', color: '#ec0000', label: 'Developed · Medium Intensity',
    description: 'Suburban — 50–79% impervious surface' },
  { code: 24, group: 'Developed',   emoji: '🏙', color: '#ab0000', label: 'Developed · High Intensity',
    description: 'Urban core, industrial — ≥ 80% impervious surface' },
  // ── Barren ─────────────────────────────────────────────────────────────
  { code: 31, group: 'Barren',      emoji: '🪨', color: '#b3afa4', label: 'Barren Land',
    description: 'Soil, sand, clay, rock with < 15% vegetation cover' },
  // ── Forest ─────────────────────────────────────────────────────────────
  { code: 41, group: 'Forest',      emoji: '🍂', color: '#68ab63', label: 'Deciduous Forest',
    description: 'Deciduous trees with > 20% canopy — key edge habitat' },
  { code: 42, group: 'Forest',      emoji: '🌲', color: '#1c6330', label: 'Evergreen Forest',
    description: 'Coniferous trees with > 20% canopy' },
  { code: 43, group: 'Forest',      emoji: '🌳', color: '#b5c98e', label: 'Mixed Forest',
    description: 'Mixed deciduous/evergreen — neither type dominates' },
  // ── Shrubland / Grassland ──────────────────────────────────────────────
  { code: 52, group: 'Shrubland',   emoji: '🌿', color: '#ccba7c', label: 'Shrub/Scrub',
    description: 'Shrubs < 5 m tall — important transition habitat for pollinators' },
  { code: 71, group: 'Grassland',   emoji: '🌾', color: '#e2e2c1', label: 'Grassland/Herbaceous',
    description: 'Graminoids and forbs — untilled, < 20% woody canopy' },
  // ── Agriculture ────────────────────────────────────────────────────────
  { code: 81, group: 'Agriculture', emoji: '🐄', color: '#dbd93d', label: 'Pasture/Hay',
    description: 'Planted/cultivated grasses and legumes for grazing or hay' },
  { code: 82, group: 'Agriculture', emoji: '🌽', color: '#aa7028', label: 'Cultivated Crops',
    description: 'Row crops, field crops — high fragmentation pressure zone' },
  // ── Wetlands ───────────────────────────────────────────────────────────
  { code: 90, group: 'Wetlands',    emoji: '🪵', color: '#bad9eb', label: 'Woody Wetlands',
    description: 'Forested and shrub wetlands with seasonally saturated soils' },
  { code: 95, group: 'Wetlands',    emoji: '🌊', color: '#70a3ba', label: 'Emergent Herbaceous Wetlands',
    description: 'Marshes and wet meadows — emergent herbaceous vegetation' },
].map(cls => ({
  id:          `nlcd-${cls.code}`,
  label:       cls.label,
  emoji:       cls.emoji,
  description: cls.description,
  defaultOn:   false,
  color:       cls.color,
  nlcdCode:    cls.code,
  group:       cls.group,
  tileUrl:     nlcdClassTileUrl(cls.code),
  attribution: '<a href="https://www.mrlc.gov/" target="_blank">MRLC NLCD 2021</a>',
}));

/**
 * Raster WMS overlay layers — rendered beneath all vector layers.
 * Each entry has a `tileUrl` (MapLibre-format WMS tile URL with {bbox-epsg-3857})
 * and an `attribution` string.
 *
 * NLCD 2021 individual class tiles are in NLCD_LAYERS above.
 * CDL:  CDL WMS also open; statistics are proxied through serve.js (/api/cdl-stats).
 *
 * @type {Array<{id:string,label:string,emoji:string,description:string,defaultOn:boolean,tileUrl:string,attribution:string}>}
 */
export const RASTER_LAYERS = [];

export const EBIRD_LAYER = [
  {
    id:          'ebird',
    label:       'eBird Sightings',
    emoji:       '🦅',
    description: 'Recent bird observations near Green Bay from Cornell Lab of Ornithology (30-day window)',
    defaultOn:   true,
  },
];

export const HAZARD_LAYERS = [
  {
    id:          'dnr-pfas',
    label:       'PFAS Chemical Sites',
    emoji:       '☣️',
    description: 'WI DNR · PFAS forever-chemical detections in surface water & fish',
    defaultOn:   true,
  },
];

/**
 * Pesticide pressure choropleth layer — county-level agricultural chemical
 * intensity derived from USDA CDL crop-type mix and application rate lookup.
 *
 * @type {{ id: string, label: string, emoji: string, description: string, defaultOn: boolean }}
 */
export const PESTICIDE_LAYER = {
  id:          'pesticide',
  label:       'Pesticide Pressure',
  emoji:       '🧪',
  description: 'County-level agricultural pesticide intensity · CDL crop-type proxy · USDA application rate lookup',
  defaultOn:   true,
};

// ── Establishment means ──────────────────────────────────────────────────────

/**
 * Establishment means definitions, keyed by the value returned by iNaturalist.
 * The `color` is used for the circle stroke ring on the map and for popup badges.
 *
 * @type {Record<string, {label: string, color: string}>}
 */
export const ESTABLISHMENT = {
  native:      { label: 'Native',      color: '#15803d' },
  endemic:     { label: 'Endemic',     color: '#065f46' },
  introduced:  { label: 'Introduced',  color: '#c2410c' },
  naturalised: { label: 'Naturalised', color: '#ea580c' },
  invasive:    { label: 'Invasive',    color: '#dc2626' },
  unknown:     { label: 'Unknown',     color: '#d1d5db' },
};

// ── MapLibre paint expressions ───────────────────────────────────────────────
//
// IMPORTANT: These are `match` expressions over *string* enum properties
// (layer_id, est_key), NOT over pre-computed hex strings stored in properties.
//
// MapLibre 4.x's tile worker serializes feature properties via postMessage.
// Any numeric or color expression that resolves to `null` in the worker will
// throw "Expected value to be of type number, but found null instead."
//
// `match` over a string enum is always safe because:
//   1. The input is a string — never null-coerced to a number.
//   2. The output (color literal) lives in the style definition, not in the
//      feature properties, so it never crosses the postMessage boundary as null.

/**
 * Circle fill color — keyed on the 'layer_id' string property.
 * @type {import('maplibre-gl').ExpressionSpecification}
 */
export const FILL_COLOR_EXPR = [
  'match', ['coalesce', ['get', 'layer_id'], ''],
  // iNaturalist sighting layers
  'pollinators',      '#38bdf8',  // sky-blue  (butterflies/bees — distinct from orange corridor)
  'native-plants',    '#4ade80',  // green-400 (native = welcome)
  'other-plants',     '#e879f9',  // fuchsia   (non-native = caution)
  'other-wildlife',   '#94a3b8',  // slate-400 (neutral)
  // GBIF layers — same hues as iNat counterparts for cross-source consistency
  'gbif-pollinators',      '#38bdf8',  // sky-blue  (same as iNat pollinators)
  'gbif-native-plants',    '#4ade80',  // green-400 (same as iNat native-plants)
  'gbif-non-native-plants','#e879f9',  // fuchsia   (same as iNat other-plants)
  // Waystation points (violet — distinct from any sighting layer)
  'waystations',           '#8b5cf6',  // violet
  // Homegrown National Park native planting yards
  'hnp',                   '#10b981',  // emerald — native planting yards
  // eBird bird sightings (Cornell Lab)
  'ebird',                 '#a78bfa',  // violet-purple
  // Hazard point layers
  'dnr-pfas',              '#ef4444',  // red   (hazard indicator)
  /* default (other-wildlife) */ '#64748b',
];

/**
 * Circle stroke color — keyed on the 'est_key' string property.
 * @type {import('maplibre-gl').ExpressionSpecification}
 */
export const STROKE_COLOR_EXPR = [
  'match', ['coalesce', ['get', 'est_key'], ''],
  'native',      '#15803d',
  'endemic',     '#065f46',
  'introduced',  '#c2410c',
  'naturalised', '#ea580c',
  'invasive',    '#dc2626',
  'waystation',  '#ffffff',   // white ring on violet waystation circles
  'hnp',         '#065f46',   // dark green ring on emerald HNP circles
  /* default (unknown) */ '#d1d5db',
];
