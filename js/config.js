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

/**
 * Earliest year for background historical iNaturalist data loading.
 * The app fetches each year from INAT_HISTORY_START_YEAR through last year
 * in the background after the initial load, caching each with a long TTL
 * so the full sighting history accumulates automatically over time.
 * Years before 2010 have very few observations for the Green Bay area.
 */
export const INAT_HISTORY_START_YEAR = 2010;

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
    emoji:       '<i class="ph ph-butterfly"></i>',
    description: 'Bees, butterflies, moths, hoverflies & hummingbirds',
    defaultOn:   true,
    vintage:     null,
  },
  {
    id:          'native-plants',
    label:       'Native Plants',
    emoji:       '<i class="ph ph-flower"></i>',
    description: 'Native & endemic plant species',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'other-plants',
    label:       'Other Plants',
    emoji:       '<i class="ph ph-flower-lotus"></i>',
    description: 'Introduced, invasive & unconfirmed plants',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'other-wildlife',
    label:       'Wildlife',
    emoji:       '<i class="ph ph-paw-print"></i>',
    description: 'Birds, mammals, non-pollinator insects, fungi & more',
    defaultOn:   false,
    vintage:     null,
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
    emoji:       '<i class="ph ph-butterfly"></i>',
    description: 'Butterflies, moths & bees from museums and research surveys',
    defaultOn:   true,
    vintage:     null,
  },
  {
    id:          'gbif-native-plants',
    label:       'Native Plants',
    emoji:       '<i class="ph ph-flower"></i>',
    description: 'Native & endemic plant records from herbaria and surveys',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'gbif-non-native-plants',
    label:       'Non-Native Plants',
    emoji:       '<i class="ph ph-flower-lotus"></i>',
    description: 'Introduced, naturalised & invasive plant records',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'gbif-wildlife',
    label:       'Wildlife',
    emoji:       '<i class="ph ph-paw-print"></i>',
    description: 'Non-pollinator animals (birds, mammals, reptiles, amphibians) from museums and research surveys',
    defaultOn:   false,
    vintage:     null,
  },
];

/**
 * FWS North American Bee Distribution Tool layers.
 * Data source: GBIF occurrence records for the six recognized bee families,
 * mirroring the dataset behind https://www.fws.gov/beetool.
 * Conservation status from NatureServe G-ranks (embedded static lookup).
 *
 * Three layers:
 *   bees-records   — all bee occurrence points, colored amber
 *   bees-richness  — heatmap density (species richness proxy)
 *   bees-imperiled — occurrence points for G1–G3 / IUCN VU+ species, colored red
 *
 * @type {Array<{id: string, label: string, emoji: string, description: string, defaultOn: boolean}>}
 */
export const BEE_LAYERS = [
  {
    id:          'bees-records',
    label:       'Bee Records',
    emoji:       '<i class="ph ph-bee"></i>',
    description: 'All GBIF occurrence records across 6 bee families (Andrenidae, Apidae, Colletidae, Halictidae, Megachilidae, Melittidae) — the same data source as the FWS Bee Distribution Tool, scoped to Brown County.',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'bees-richness',
    label:       'Species Richness',
    emoji:       '<i class="ph ph-chart-bar"></i>',
    description: 'Heatmap of bee record density — a spatial proxy for species richness. Brighter areas have more bee specimens documented in GBIF collections.',
    defaultOn:   false,
    vintage:     null,
  },
  {
    id:          'bees-imperiled',
    label:       'Imperiled Species',
    emoji:       '<i class="ph ph-warning"></i>',
    description: 'Occurrences of bee species with NatureServe global ranks G1–G3 (Critically Imperiled to Vulnerable) or IUCN Vulnerable / Endangered / Critically Endangered. Includes federally listed species (e.g. Rusty-patched Bumble Bee).',
    defaultOn:   true,
    vintage:     null,
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
    emoji:        '<i class="ph ph-shield"></i>',
    description:  'USGS PAD-US v3.0 · federal, state, local & tribal protected lands',
    defaultOn:    false,
    fillColor:    '#16a34a',
    outlineColor: '#15803d',
    vintage:      { year: 2023 },
  },
  {
    id:           'dnr-sna',
    label:        'State Natural Areas',
    emoji:        '<i class="ph ph-tree"></i>',
    description:  'WI DNR State Natural Areas · preserved natural communities',
    defaultOn:    true,
    fillColor:    '#0891b2',
    outlineColor: '#0e7490',
    vintage:      { year: 2023 },
  },
  {
    id:           'dnr-managed',
    label:        'DNR Managed Lands',
    emoji:        '<i class="ph ph-tent"></i>',
    description:  'WI DNR managed properties · wildlife areas, forests & parks',
    defaultOn:    false,
    fillColor:    '#7c3aed',
    outlineColor: '#6d28d9',
    vintage:      { year: 2023 },
  },
  {
    id:           'gbcc-corridor',
    label:        'Pollinator Corridor',
    emoji:        '<i class="ph ph-path"></i>',
    description:  'NE Wisconsin Pollinator Corridor · mapped planting areas (Green Bay Conservation Corps)',
    defaultOn:    true,
    fillColor:    '#f59e0b',
    outlineColor: '#d97706',
    vintage:      null,
  },
  {
    id:           'gbcc-treatment',
    label:        'Habitat Treatments',
    emoji:        '<i class="ph ph-plant"></i>',
    description:  'GBCC restoration sites · cut-stump & foliar treatments',
    defaultOn:    true,
    fillColor:    '#a3e635',
    outlineColor: '#65a30d',
    vintage:      null,
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
    emoji:       '<i class="ph ph-butterfly"></i>',
    description: 'Monarch Watch certified waystation habitats (locations confirmed via Brown County parcel records)',
    defaultOn:   true,
    vintage:     null,
  },
];

export const HNP_LAYER = [
  {
    id:          'hnp',
    label:       'Homegrown National Park',
    emoji:       '<i class="ph ph-leaf"></i>',
    description: 'Registered native plant yards contributing to local biodiversity (Homegrown National Park)',
    defaultOn:   true,
    vintage:     null,
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
  { code: 11, group: 'Water',       emoji: '<i class="ph ph-drop"></i>', color: '#476ba1', label: 'Open Water',
    description: 'Streams, lakes, ponds, reservoirs, and estuaries' },
  { code: 12, group: 'Water',       emoji: '<i class="ph ph-snowflake"></i>', color: '#d1defa', label: 'Perennial Ice/Snow',
    description: 'Permanent snow and ice — minimal in Wisconsin' },
  // ── Developed ──────────────────────────────────────────────────────────
  { code: 21, group: 'Developed',   emoji: '<i class="ph ph-house-line"></i>', color: '#ddc9c9', label: 'Developed · Open Space',
    description: 'Lawns, parks, golf courses — impervious surface < 20%' },
  { code: 22, group: 'Developed',   emoji: '<i class="ph ph-house"></i>', color: '#d89382', label: 'Developed · Low Intensity',
    description: 'Residential — 20–49% impervious surface' },
  { code: 23, group: 'Developed',   emoji: '<i class="ph ph-buildings"></i>', color: '#ec0000', label: 'Developed · Medium Intensity',
    description: 'Suburban — 50–79% impervious surface' },
  { code: 24, group: 'Developed',   emoji: '<i class="ph ph-city"></i>', color: '#ab0000', label: 'Developed · High Intensity',
    description: 'Urban core, industrial — ≥ 80% impervious surface' },
  // ── Barren ─────────────────────────────────────────────────────────────
  { code: 31, group: 'Barren',      emoji: '<i class="ph ph-mountains"></i>', color: '#b3afa4', label: 'Barren Land',
    description: 'Soil, sand, clay, rock with < 15% vegetation cover' },
  // ── Forest ─────────────────────────────────────────────────────────────
  { code: 41, group: 'Forest',      emoji: '<i class="ph ph-tree"></i>', color: '#68ab63', label: 'Deciduous Forest',
    description: 'Deciduous trees with > 20% canopy — key edge habitat' },
  { code: 42, group: 'Forest',      emoji: '<i class="ph ph-tree-evergreen"></i>', color: '#1c6330', label: 'Evergreen Forest',
    description: 'Coniferous trees with > 20% canopy' },
  { code: 43, group: 'Forest',      emoji: '<i class="ph ph-tree"></i>', color: '#b5c98e', label: 'Mixed Forest',
    description: 'Mixed deciduous/evergreen — neither type dominates' },
  // ── Shrubland / Grassland ──────────────────────────────────────────────
  { code: 52, group: 'Shrubland',   emoji: '<i class="ph ph-plant"></i>', color: '#ccba7c', label: 'Shrub/Scrub',
    description: 'Shrubs < 5 m tall — important transition habitat for pollinators' },
  { code: 71, group: 'Grassland',   emoji: '<i class="ph ph-plant"></i>', color: '#e2e2c1', label: 'Grassland/Herbaceous',
    description: 'Graminoids and forbs — untilled, < 20% woody canopy' },
  // ── Agriculture ────────────────────────────────────────────────────────
  { code: 81, group: 'Agriculture', emoji: '<i class="ph ph-cow"></i>', color: '#dbd93d', label: 'Pasture/Hay',
    description: 'Planted/cultivated grasses and legumes for grazing or hay' },
  { code: 82, group: 'Agriculture', emoji: '<i class="ph ph-plant"></i>', color: '#aa7028', label: 'Cultivated Crops',
    description: 'Row crops, field crops — high fragmentation pressure zone' },
  // ── Wetlands ───────────────────────────────────────────────────────────
  { code: 90, group: 'Wetlands',    emoji: '<i class="ph ph-tree"></i>', color: '#bad9eb', label: 'Woody Wetlands',
    description: 'Forested and shrub wetlands with seasonally saturated soils' },
  { code: 95, group: 'Wetlands',    emoji: '<i class="ph ph-waves"></i>', color: '#70a3ba', label: 'Emergent Herbaceous Wetlands',
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
  vintage:     { year: 2021 },
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

// ── WI DNR Urban Tree Canopy layers ──────────────────────────────────────────

/**
 * Three survey years of WI DNR 1 m-resolution urban tree canopy classification
 * derived from NAIP aerial imagery.  All three layers are registered on map load
 * and the timeline scrubber shows exactly one at a time (the most recent year
 * whose survey date is ≤ the timeline's end year).
 *
 * @type {Array<{id:string, year:number, tileUrl:string, attribution:string}>}
 */
const _TC_BASE = 'https://dnrmaps.wi.gov/arcgis_image/rest/services/FR_URBAN_FORESTRY';
const _TC_RULE = '%7B%22rasterFunction%22%3A%22Green-Brown_value_1%22%7D'; // {"rasterFunction":"Green-Brown_value_1"}
function _tcTileUrl(year) {
  return `${_TC_BASE}/FR_Urban_Tree_Canopy_Raster_${year}/ImageServer/exportImage` +
    `?bbox={bbox-epsg-3857}&bboxSR=3857&size=256,256&imageSR=3857` +
    `&format=png32&renderingRule=${_TC_RULE}` +
    `&noData=255&noDataInterpretation=esriNoDataMatchAny&f=image`;
}
export const TREE_CANOPY_YEARS  = [2013, 2020, 2022];
export const TREE_CANOPY_LAYERS = TREE_CANOPY_YEARS.map(year => ({
  id:          `tree-canopy-${year}`,
  year,
  tileUrl:     _tcTileUrl(year),
  attribution: `<a href="https://dnr.wisconsin.gov/topic/urbanforests/ufia/plan-treecanopy" target="_blank">WI DNR Urban Tree Canopy ${year}</a>`,
  vintage:     { year },
}));

export const EBIRD_LAYER = [
  {
    id:          'ebird',
    label:       'eBird Sightings',
    emoji:       '<i class="ph ph-bird"></i>',
    description: 'Recent bird observations near Green Bay from Cornell Lab of Ornithology (30-day window)',
    defaultOn:   false,
    vintage:     null,
  },
];

export const HAZARD_LAYERS = [
  {
    id:          'dnr-pfas',
    label:       'PFAS Chemical Sites',
    emoji:       '<i class="ph ph-biohazard"></i>',
    description: 'WI DNR · PFAS forever-chemical detections in surface water & fish',
    defaultOn:   true,
    vintage:     null,
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
  emoji:       '<i class="ph ph-flask"></i>',
  description: 'County-level agricultural pesticide intensity · CDL crop-type proxy · USDA application rate lookup',
  defaultOn:   false,
  vintage:     { year: 2023 },
};

export const PARCEL_LAYER = {
  id:          'parcels',
  label:       'Parcel Ownership',
  emoji:       '📐',
  description: 'Brown County parcel boundaries colored by ownership class (City / County / State / Institutional / Private). Visible at neighborhood zoom (≥ 14). Lazy-loaded on first toggle.',
  defaultOn:   false,
  vintage:     { year: 2024 },
};

export const COMMONS_LAYER = {
  id:          'commons-photos',
  label:       '📷 Commons Photos',
  emoji:       '📷',
  description: 'Wikimedia Commons geotagged nature/habitat photography within 10 km. Click a camera marker to view the photo and license.',
  defaultOn:   false,
  vintage:     null,
};

// ── Analysis layers ──────────────────────────────────────────────────────────

/**
 * Expansion Opportunities — active pollinator zones without nearby formal
 * habitat, scored green / amber / red by native plant presence, PFAS proximity,
 * and pesticide pressure.
 */
export const EXPANSION_LAYER = [
  {
    id:          'expansion-opportunities',
    label:       'Expansion Opportunities',
    emoji:       '<i class="ph ph-trend-up"></i>',
    description: 'Areas with documented pollinator activity and no nearby formal habitat site — scored by native plant diversity, pollution proximity, and pesticide pressure. Green = good suitability, amber = moderate, red = limiting factors present.',
    defaultOn:   false,
    vintage:     null,
  },
];

/**
 * InVEST / Lonsdorf Pollinator Index layer — landscape scale.
 * 1.3 km grid. Scores reflect the surrounding landscape matrix, NOT individual
 * plantings. Rural grassland/wetland naturally dominates. See INVEST_URBAN_LAYER
 * for within-urban comparison.
 */
export const INVEST_LAYER = {
  id:          'invest-heat',
  label:       'Landscape Suitability Index',
  emoji:       '<i class="ph ph-chart-line-up"></i>',
  description: 'InVEST / Lonsdorf (2009) landscape-scale pollinator index. Samples NLCD 2021 land cover on a 1.3&nbsp;km grid — each cell reflects its surrounding land cover matrix, not what&rsquo;s specifically planted there. Individual corridor sites (&lt;1 acre) are invisible at this resolution. Rural areas with extensive grassland or wetland will dominate. Use as regional landscape context, not as a measure of corridor program effectiveness.',
  defaultOn:   false,
  vintage:     { year: 2021 },
};

/**
 * Urban InVEST — same Lonsdorf kernel but normalized against urban cells only.
 * 330 m fine grid. Shows relative habitat quality within the developed footprint.
 */
export const INVEST_URBAN_LAYER = {
  id:          'invest-urban-heat',
  label:       'Urban Habitat Index',
  emoji:       '<i class="ph ph-buildings"></i>',
  description: 'Adapted from the InVEST Lonsdorf&nbsp;(2009) model, which was designed and calibrated for agricultural landscapes. By default that model rates all urban land as low-quality habitat. This layer re-runs the same kernel at 660&nbsp;m resolution, keeps only developed NLCD cells (≥20% impervious), and normalizes the score against the best urban cell in the study area — so a city park surrounded by pavement can score near 1.0 rather than being washed out by Suamico-area wetlands. Guild weights shift toward small and medium solitary bees (Osmia, Lasioglossum), which dominate urban green patches.',
  defaultOn:   false,
  vintage:     { year: 2021 },
};

/**
 * Foraging-range bands — concentric rings around each corridor site showing
 * the reach of the three bee guilds.
 */
export const FORAGING_BANDS_LAYER = {
  id:          'foraging-bands',
  label:       'Foraging Range Bands',
  emoji:       '<i class="ph ph-circles-three"></i>',
  description: 'Three concentric rings around each corridor site showing the foraging range of small solitary bees (300&nbsp;m, teal), medium solitary bees (700&nbsp;m, amber), and bumble bees (1.5&nbsp;km, rose). Overlapping rings from adjacent sites darken naturally — dense overlap indicates strong landscape connectivity. Styled intentionally like pressure-chart isobars.',
  defaultOn:   false,
  vintage:     null,
};

/**
 * Site Signals — corridor sites with inferred indicators worth watching: PFAS proximity,
 * isolation, no sightings, poor nesting, high canopy shading, or pesticide pressure.
 * Severity: red = high, amber = medium, gray = low.
 */
export const PROBLEM_AREAS_LAYER = [
  {
    id:          'problem-areas',
    label:       'Site Signals',
    emoji:       '<i class="ph ph-warning-circle"></i>',
    description: 'Habitat sites with inferred indicators worth monitoring: PFAS proximity, network isolation, no documented sightings, poor nesting substrate, excessive canopy shading, or high pesticide pressure. Color indicates signal strength.',
    defaultOn:   false,
    vintage:     null,
  },
];

// ── Layer presets ("Views") ───────────────────────────────────────────────────

/**
 * Named layer combinations for the Views flyout pane.
 *
 * Each preset carries:
 *   id          — unique kebab-case key
 *   label       — short display name
 *   icon        — Phosphor icon class (no leading "ph ph-")
 *   description — one-sentence purpose statement
 *   on          — array of layer ids (from config arrays) AND hardcoded-cb
 *                 suffixes ('heatmap-traffic', 'heatmap-native-plants',
 *                 'tree-canopy', 'cdl-fringe') to enable.
 *                 Everything NOT in this array is turned OFF (full-replace).
 *
 * @type {Array<{id:string, label:string, icon:string, description:string, on:string[]}>}
 */
export const LAYER_PRESETS = [
  {
    id:          'orientation',
    label:       'Orientation',
    icon:        'compass',
    description: 'Network overview with active threats — the recommended first look.',
    on: [
      'gbcc-corridor', 'gbcc-treatment', 'waystations', 'hnp',
      'dnr-pfas', 'problem-areas', 'cdl-fringe',
    ],
  },
  {
    id:          'site-assessment',
    label:       'Site Assessment',
    icon:        'magnifying-glass-plus',
    description: 'Per-site nesting suitability and land cover — enables nesting score badges.',
    on: [
      'gbcc-corridor', 'waystations', 'bees-imperiled',
      'nlcd-52', 'nlcd-71', 'nlcd-90', 'nlcd-95', 'tree-canopy',
    ],
  },
  {
    id:          'expansion',
    label:       'Expansion Planning',
    icon:        'trend-up',
    description: 'Where to place new habitat — opportunity zones, public land, and constraints.',
    on: [
      'gbcc-corridor', 'waystations', 'pollinators', 'gbif-pollinators',
      'expansion-opportunities', 'padus', 'dnr-managed',
      'pesticide', 'dnr-pfas', 'parcels',
    ],
  },
  {
    id:          'species-monitoring',
    label:       'Species Monitoring',
    icon:        'binoculars',
    description: 'Full sightings picture — pollinators, native plants, and imperiled bees.',
    on: [
      'pollinators', 'native-plants', 'gbif-pollinators', 'gbif-native-plants',
      'bees-imperiled', 'bees-richness', 'gbcc-corridor', 'waystations',
    ],
  },
  {
    id:          'agricultural',
    label:       'Agricultural Interface',
    icon:        'plant',
    description: 'Crop pressure, pollinator supply model, and where bees are active.',
    on: [
      'gbcc-corridor', 'waystations', 'pollinators',
      'pesticide', 'invest-heat', 'cdl-fringe', 'heatmap-traffic',
    ],
  },
  {
    id:          'contamination',
    label:       'Contamination Triage',
    icon:        'biohazard',
    description: 'Pure threat view — PFAS, pesticide pressure, and affected sites.',
    on: [
      'gbcc-corridor', 'waystations', 'dnr-pfas', 'pesticide', 'problem-areas',
    ],
  },
  {
    id:          'urban-canopy',
    label:       'Urban Canopy',
    icon:        'tree-evergreen',
    description: 'Tree canopy coverage and its impact on corridor site viability.',
    on: [
      'gbcc-corridor', 'waystations', 'problem-areas', 'tree-canopy', 'nlcd-21',
    ],
  },
  {
    id:          'urban-analysis',
    label:       'Urban Analysis',
    icon:        'city',
    description: 'Urban habitat quality landscape — InVEST index, foraging range bands, land cover, and canopy.',
    on: [
      'gbcc-corridor', 'invest-urban-heat', 'foraging-bands', 'tree-canopy', 'nlcd-21',
    ],
  },
];

// ── Temporal freshness constants ──────────────────────────────────────────────

/** Years past vintage at which a raster layer is considered stale (dimmed). */
export const STALENESS_THRESHOLD_YEARS = 3;

/** Years past vintage at which a temporal-mismatch alert is raised. */
export const TEMPORAL_MISMATCH_THRESHOLD_YEARS = 3;

/**
 * Flat Map of every layer id → vintage `{ year }` for layers with a fixed
 * data vintage. Live layers (vintage == null) are omitted.
 * @type {Map<string, { year: number }>}
 */
export const LAYER_VINTAGES = new Map(
  [
    ...LAYERS, ...GBIF_LAYERS, ...BEE_LAYERS, ...AREA_LAYERS,
    ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...NLCD_LAYERS,
    ...TREE_CANOPY_LAYERS, ...EBIRD_LAYER, ...EXPANSION_LAYER, ...PROBLEM_AREAS_LAYER,
    PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, INVEST_LAYER,
  ]
    .filter(l => l.vintage != null)
    .map(l => [l.id, l.vintage])
);

/**
 * Flat Map of every layer id → human-readable label.
 * Used by the temporal-mismatch alert to name stale layers.
 * @type {Map<string, string>}
 */
export const LAYER_LABELS = new Map(
  [
    ...LAYERS, ...GBIF_LAYERS, ...BEE_LAYERS, ...AREA_LAYERS,
    ...HAZARD_LAYERS, ...WAYSTATION_LAYER, ...HNP_LAYER, ...NLCD_LAYERS,
    ...TREE_CANOPY_LAYERS, ...EBIRD_LAYER, ...EXPANSION_LAYER, ...PROBLEM_AREAS_LAYER,
    PESTICIDE_LAYER, PARCEL_LAYER, COMMONS_LAYER, INVEST_LAYER,
  ]
    .filter(l => l.label != null)
    .map(l => [l.id, l.label])
);

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
  'gbif-wildlife',         '#94a3b8',  // slate-400 (same as iNat other-wildlife)
  // FWS Bee Distribution Tool layers
  'bees-records',          '#f59e0b',  // amber    (honey-bee amber — all bee records)
  'bees-imperiled',        '#ef4444',  // red      (conservation concern)
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
