/**
 * landcover.js — National Land Cover Database (NLCD) and USDA NASS Cropland
 * Data Layer (CDL) integration.
 *
 * NLCD is served directly by the MRLC geoserver as a WMS with CORS open (*),
 * so MapLibre fetches tiles directly — no proxy needed.
 *
 * CDL statistics are fetched via /api/cdl-stats (proxied through serve.js)
 * because nassgeodata.gmu.edu returns no CORS headers.  The stats cover Brown
 * County, WI (FIPS 55009) and are cached for 24 h.  They are consumed by
 * alerts.js to compute pollinator mismatch alerts.
 *
 * Data sources:
 *   NLCD 2021  — USGS/MRLC National Land Cover Database
 *     https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/ows
 *   CDL 2023   — USDA NASS Cropland Data Layer via CropScape
 *     https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLStat
 */

// ── CDL bee-dependency classification ────────────────────────────────────────

/**
 * CDL crop value codes meaningfully dependent on managed or wild bee pollination.
 * Sources: USDA NRCS "Plants for Pollinators" list; Winfree et al. (2011)
 * pollination-dependency coefficients; Klein et al. (2007) global review.
 */
export const BEE_DEPENDENT_CODES = new Set([
  5,              // Soybeans (marginal — higher yields with bee visits)
  12,             // Sweet Corn
  36,             // Alfalfa (seed production heavily dependent)
  37, 58,         // Other Hay / Clover-Wildflowers (forage; attracts pollinators)
  54,             // Tomatoes
  55,             // Peppers
  56, 57, 12,     // Cucumbers, Squash (cucurbit family — high dependency)
  59,             // Sod/Grass Seed (clover-heavy mixes)
  62,             // Cranberries (Wisconsin's major bee-dependent specialty crop)
  66, 67, 68, 74, // Sweet cherries, peaches, apples, pears
  69, 75,         // Grapes, small fruits
  206, 211,       // Vetch, Clover/Wildflowers
  242,            // Blueberries (extremely high dependency)
  243,            // Potatoes (yield benefit from bee visits)
]);

/**
 * Returns true when a CDL value code represents any cultivated cropland
 * (excludes developed land, forest, wetlands, open water, etc.).
 * @param {number} code
 */
export function isCultivatedCrop(code) {
  return (code >= 1 && code <= 80) || code === 82 || (code >= 204 && code <= 254);
}

/**
 * Returns true when the crop is meaningfully bee-dependent.
 * @param {number} code
 */
export function isBeeDependentCrop(code) {
  return BEE_DEPENDENT_CODES.has(code);
}

// ── CDL statistics fetch ──────────────────────────────────────────────────────

/**
 * Fetches Cropland Data Layer statistics for Brown County, WI (FIPS 55009)
 * via the /api/cdl-stats proxy route in serve.js.
 *
 * Returns a stats object on success, or null on network/parse failure so
 * mismatch alerts are simply skipped rather than crashing.
 *
 * @returns {Promise<{
 *   rows: Array<{value:number, category:string, acreage:number}>,
 *   totalAcres: number,
 *   cropAcres: number,
 *   beeAcres: number,
 *   cropPct: number,
 *   beePct: number,
 *   beeOfCropPct: number,
 *   topBeeCrops: Array<{category:string, acreage:number}>,
 * }|null>}
 */
export async function fetchCdlStats() {
  try {
    const res = await fetch('/api/cdl-stats');
    if (!res.ok) return null;
    const json = await res.json();
    return parseCdlStats(json);
  } catch {
    return null;
  }
}

/**
 * Fetches USDA NASS QuickStats data via the /api/quickstats proxy in serve.js.
 *
 * Returns an object with colony count and notable crop acres on success.
 * `available: false` means no API key is configured; the app degrades cleanly.
 *
 * @returns {Promise<{available:boolean, colonies:number|null, coloniesYear:number|null,
 *   notableAcres:object, totalNotableAcres:number}|null>}
 */
export async function fetchQuickStats() {
  try {
    const res = await fetch('/api/quickstats');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function parseCdlStats(json) {
  const rows = json?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let totalAcres = 0;
  let cropAcres  = 0;
  let beeAcres   = 0;
  const topBeeCrops = [];

  for (const row of rows) {
    const code   = Number(row.value);
    const acres  = Number(row.acreage) || 0;
    totalAcres  += acres;
    if (isCultivatedCrop(code)) cropAcres += acres;
    if (isBeeDependentCrop(code)) {
      beeAcres += acres;
      topBeeCrops.push({ category: row.category, acreage: acres });
    }
  }

  if (totalAcres === 0) return null;

  topBeeCrops.sort((a, b) => b.acreage - a.acreage);

  return {
    rows,
    totalAcres,
    cropAcres,
    beeAcres,
    cropPct:      cropAcres / totalAcres  * 100,
    beePct:       beeAcres  / totalAcres  * 100,
    beeOfCropPct: cropAcres > 0 ? beeAcres / cropAcres * 100 : 0,
    topBeeCrops:  topBeeCrops.slice(0, 5),
  };
}

/**
 * Fetches the CDL agricultural fringe heatmap point data via the
 * /api/cdl-fringe proxy in serve.js.
 *
 * Returns a GeoJSON FeatureCollection whose Point features carry a `weight`
 * property [0–1] indicating bee-pollination dependency for that crop pixel.
 * Returns null on failure so the overlay is silently skipped.
 *
 * @returns {Promise<GeoJSON.FeatureCollection|null>}
 */
export async function fetchCdlFringe() {
  try {
    const res = await fetch('/api/cdl-fringe');
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
