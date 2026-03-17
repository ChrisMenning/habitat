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
    emoji:       '🌸',
    description: 'Bees, butterflies, moths, hoverflies & hummingbirds',
    defaultOn:   true,
  },
  {
    id:          'native-plants',
    label:       'Native Plants',
    emoji:       '🌿',
    description: 'Native & endemic plant species',
    defaultOn:   true,
  },
  {
    id:          'other-plants',
    label:       'Other Plants',
    emoji:       '🌱',
    description: 'Introduced, invasive & unconfirmed plants',
    defaultOn:   true,
  },
  {
    id:          'other-wildlife',
    label:       'Wildlife',
    emoji:       '🐾',
    description: 'Birds, mammals, non-pollinator insects, fungi & more',
    defaultOn:   true,
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
    emoji:       '🔬',
    description: 'Butterflies, moths & bees from museums and research surveys',
    defaultOn:   true,
  },
  {
    id:          'gbif-plants',
    label:       'Plants',
    emoji:       '🌾',
    description: 'Plant records including herbarium specimens',
    defaultOn:   true,
  },
];

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
  'match', ['get', 'layer_id'],
  // iNaturalist layers (warm, saturated)
  'pollinators',      '#f97316',  // orange
  'native-plants',    '#22c55e',  // green
  'other-plants',     '#84cc16',  // yellow-green
  // GBIF layers (cool, desaturated — visually distinct from iNat)
  'gbif-pollinators', '#818cf8',  // indigo
  'gbif-plants',      '#2dd4bf',  // teal
  /* default (other-wildlife) */ '#64748b',
];

/**
 * Circle stroke color — keyed on the 'est_key' string property.
 * @type {import('maplibre-gl').ExpressionSpecification}
 */
export const STROKE_COLOR_EXPR = [
  'match', ['get', 'est_key'],
  'native',      '#15803d',
  'endemic',     '#065f46',
  'introduced',  '#c2410c',
  'naturalised', '#ea580c',
  'invasive',    '#dc2626',
  /* default (unknown) */ '#d1d5db',
];
