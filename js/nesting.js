/**
 * nesting.js — Ground-nesting habitat suitability scoring for corridor sites.
 *
 * NLCD 2021 classes used (fetched from the /api/nlcd-nesting server-side batch
 * endpoint, which pixel-counts each class within a 300 m radius of each site):
 *
 *   31  Barren Land          bare soil/sand/rock — prime ground-nesting substrate  weight 3
 *   52  Shrub/Scrub          stem- and cavity-nesting; also ground-nesting          weight 2
 *   71  Grassland/Herbaceous untilled herbaceous cover                              weight 3
 *
 * Score 0–100:
 *   0–33   Low      (gray)       — minimal nesting substrate, alert fires at < 25
 *   34–66  Moderate (tan)        — some shrub/grassland present
 *   67–100 Good     (dark brown) — substantial bare or herbaceous ground cover
 *
 * Scaling: 20% weighted-pixel coverage within the 300 m radius → score 100.
 * This matches the expected range for well-maintained NE Wisconsin corridor sites.
 */

// ── Score → tier mapping ──────────────────────────────────────────────────────

/**
 * Maps a nesting score (0–100) to a tier descriptor.
 *
 * @param {number} score
 * @returns {{ tier: 'low'|'moderate'|'good', label: string, color: string }}
 */
export function nestingTier(score) {
  if (score >= 67) return { tier: 'good',     label: 'Good',     color: '#6b3a2a' };
  if (score >= 34) return { tier: 'moderate', label: 'Moderate', color: '#b58a5a' };
  return                  { tier: 'low',      label: 'Low',      color: '#9ca3af' };
}

/**
 * Returns a plain-language description of the nesting score for the drawer.
 *
 * @param {number} score
 * @param {{ 31: number, 52: number, 71: number }} counts  — raw pixel counts
 * @returns {string}
 */
export function nestingDescription(score, counts) {
  const top = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([ka, a], [kb, b]) => b * ({ 31: 3, 52: 2, 71: 3 }[kb] ?? 1) - a * ({ 31: 3, 52: 2, 71: 3 }[ka] ?? 1))
    .map(([code]) =>
      code === '31' ? 'bare and sparse ground cover'
      : code === '52' ? 'shrub/scrub cover'
      : 'grassland/herbaceous cover'
    );

  if (!top.length) {
    return 'Little bare ground, shrubland, or grassland detected within 300 m — '
         + 'limited nesting substrate for ground-nesting bees.';
  }

  const { label } = nestingTier(score);
  const resource  = top[0];
  const qualifier = score >= 67 ? 'Good' : score >= 34 ? 'Some' : 'Limited';
  return `${qualifier} ${resource} nearby — ${label.toLowerCase()} nesting conditions for ground-nesting bees.`;
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetches nesting suitability scores for a set of corridor site centroid features.
 *
 * The server queries NLCD 2021 WMS tiles and counts pixels of classes 31, 52, 71
 * within 300 m of each centroid.
 *
 * @param {GeoJSON.Feature[]} centroidFeatures  — corridor/waystation Point features
 * @returns {Promise<Map<string, {score:number, counts:{31:number,52:number,71:number}, total:number}>>}
 *   Map keyed by `feature.properties.name ?? "site-{i}"`.
 */
export async function fetchNestingScores(centroidFeatures) {
  if (!centroidFeatures?.length) return new Map();

  const sites = centroidFeatures.map((f, i) => ({
    id:  String(f.properties?.name ?? `site-${i}`),
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  try {
    const res = await fetch(`/api/nlcd-nesting?sites=${encodeURIComponent(JSON.stringify(sites))}`);
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map();
    for (const item of data) {
      map.set(item.id, { score: item.score, counts: item.counts, total: item.total });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Fetches tree canopy coverage percentages for a set of corridor site centroid features.
 *
 * The server queries the 2022 WI DNR Urban Tree Canopy ImageServer and counts
 * tree vs. non-tree pixels within ~150 m of each site centroid.
 *
 * @param {GeoJSON.Feature[]} centroidFeatures  — corridor Point features
 * @returns {Promise<Map<string, number>>}
 *   Map keyed by `feature.properties.name ?? "site-{i}"`, value is canopyPct (0–100).
 *   Sites where pixel data was unavailable are omitted from the map.
 */
export async function fetchCanopyScores(centroidFeatures) {
  if (!centroidFeatures?.length) return new Map();

  const sites = centroidFeatures.map((f, i) => ({
    id:  String(f.properties?.name ?? `site-${i}`),
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
  }));

  try {
    const res = await fetch(`/api/canopy-check?sites=${encodeURIComponent(JSON.stringify(sites))}`);
    if (!res.ok) return new Map();
    const data = await res.json();
    const map = new Map();
    for (const item of data) {
      if (typeof item.canopyPct === 'number') map.set(item.id, item.canopyPct);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ── Grid-level NLCD scoring ───────────────────────────────────────────────────

/**
 * Canonical key for a grid cell at 0.003° resolution (~300 m).
 * Matches the 0.012° grid step used in computeSuitabilityPoints.
 */
export function nlcdGridKey(lng, lat) {
  return `${(+lng).toFixed(3)},${(+lat).toFixed(3)}`;
}

/**
 * Fetches per-cell NLCD scores for every grid point covering the analysis area.
 *
 * Generates a uniform grid at `gridStep` spacing within `radiusKm` of the
 * center, batches requests to `/api/nlcd-nesting` in groups of 500, and
 * returns a Map keyed by `nlcdGridKey(lng, lat)`.
 *
 * @param {number} centerLng
 * @param {number} centerLat
 * @param {number} radiusKm
 * @param {number} [gridStep=0.012]  — must match GRID_STEP in alerts.js
 * @returns {Promise<Map<string, {score:number, counts:{11:number,31:number,52:number,71:number}, total:number}>>}
 */
export async function fetchGridNlcdScores(centerLng, centerLat, radiusKm, gridStep = 0.012) {
  const DEG_LAT = 1 / 111.32;
  const DEG_LNG = 1 / (111.32 * Math.cos(centerLat * Math.PI / 180));
  const latMin = centerLat - radiusKm * DEG_LAT;
  const latMax = centerLat + radiusKm * DEG_LAT;
  const lngMin = centerLng - radiusKm * DEG_LNG;
  const lngMax = centerLng + radiusKm * DEG_LNG;

  // Build full site list (same grid as computeSuitabilityPoints)
  const allSites = [];
  for (let lat = latMin; lat <= latMax; lat += gridStep) {
    for (let lng = lngMin; lng <= lngMax; lng += gridStep) {
      const dLat = (lat - centerLat) * 111.32;
      const dLng = (lng - centerLng) * 111.32 * Math.cos(centerLat * Math.PI / 180);
      if (dLat * dLat + dLng * dLng > radiusKm * radiusKm) continue;
      allSites.push({ id: nlcdGridKey(lng, lat), lng: +lng.toFixed(6), lat: +lat.toFixed(6) });
    }
  }

  const BATCH = 500;
  const result = new Map();

  for (let i = 0; i < allSites.length; i += BATCH) {
    const batch = allSites.slice(i, i + BATCH);
    try {
      const res = await fetch(`/api/nlcd-nesting?sites=${encodeURIComponent(JSON.stringify(batch))}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of data) {
        result.set(item.id, { score: item.score, counts: item.counts, total: item.total });
      }
    } catch {
      // Network failure for this batch — skip silently
    }
  }
  return result;
}

/**
 * Enriches a GeoJSON FeatureCollection of corridor centroids with nesting score
 * properties so MapLibre symbol layers can read them via ['get', 'nesting_score'].
 *
 * @param {GeoJSON.FeatureCollection} centroids
 * @param {Map<string, {score:number, counts:object, total:number}>} scoresMap
 * @returns {GeoJSON.FeatureCollection}
 */
export function enrichCentroidsWithNesting(centroids, scoresMap) {
  const features = centroids.features.map((f, i) => {
    const key  = String(f.properties?.name ?? `site-${i}`);
    const info = scoresMap.get(key);
    if (!info) return f;
    const { tier } = nestingTier(info.score);
    return {
      ...f,
      properties: {
        ...f.properties,
        nesting_score: info.score,
        nesting_tier:  tier,
        nesting_counts: info.counts,
        nesting_total:  info.total,
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

// ── InVEST / Lonsdorf Pollinator Model ───────────────────────────────────────
//
// Implements the Lonsdorf et al. (2009) pollinator abundance index using
// NLCD 2021 biophysical lookup tables adapted from peer-reviewed sources:
//
//   Lonsdorf et al. (2009) Ecol. Appl. 19(8): 2096–2110  — original model
//   Sharp et al. (2018) InVEST User's Guide v3.5 Table 1  — LULC attribute table
//   Wentling et al. (2021) Landsc. Ecol.                  — NLCD-specific scoring
//
// Core equation (per cell x):
//   P(x) = N(x) × (1/G) × Σ_guild [ Σ_j F(j) × e^(−D(x,j)/α_guild) ]
//
// Where:
//   N(x) = nesting suitability of cell x (0–1, weighted by NLCD class proportions)
//   F(j) = floral resource score of cell j (0–1)
//   D    = distance from x to j in km
//   α    = guild mean foraging range in km (small/medium/large)
//   G    = number of guilds (3)

/**
 * Ground-nesting suitability per NLCD 2021 class (0.0–1.0).
 * Source: Lonsdorf 2009 Table 1 + Wentling 2021 supplementary Table S1,
 * adapted to NLCD 2021 class definitions.
 */
export const INVEST_NESTING = {
  11: 0.00,  // Open Water
  21: 0.20,  // Developed Open Space (parks, lawns — some bare patches)
  22: 0.05,  // Developed Low Intensity
  23: 0.00,  // Developed Medium Intensity
  24: 0.00,  // Developed High Intensity
  31: 0.90,  // Barren Land — prime bare-soil nesting substrate
  41: 0.10,  // Deciduous Forest — edge patches
  42: 0.05,  // Evergreen Forest
  43: 0.10,  // Mixed Forest
  52: 0.60,  // Shrub/Scrub — exposed soil between shrubs
  71: 0.80,  // Grassland/Herbaceous — extensive bare-ground nesting habitat
  81: 0.50,  // Pasture/Hay — exposed soil in shorter-stature vegetation
  82: 0.10,  // Cultivated Crops — disrupted by tillage and pesticides
  90: 0.05,  // Woody Wetlands — too wet
  95: 0.10,  // Emergent Herbaceous Wetlands — limited dry microsites
};

/**
 * Floral resource availability per NLCD 2021 class (0.0–1.0).
 * Source: Sharp et al. 2018 InVEST User's Guide Table 1 + Wentling 2021,
 * adapted for Upper Midwest native bee communities.
 */
export const INVEST_FLORAL = {
  11: 0.00,  // Open Water
  21: 0.40,  // Developed Open Space — parks, managed green areas; high flower diversity
  22: 0.15,  // Developed Low Intensity — gardens, weedy lawns
  23: 0.05,  // Developed Medium Intensity
  24: 0.00,  // Developed High Intensity
  31: 0.05,  // Barren Land — sparse ruderal flowering plants
  41: 0.30,  // Deciduous Forest — spring ephemerals, forest-edge wildflowers
  42: 0.10,  // Evergreen Forest — limited understory
  43: 0.20,  // Mixed Forest
  52: 0.65,  // Shrub/Scrub — elderberry, wild rose, flowering shrubs
  71: 0.85,  // Grassland/Herbaceous — native wildflower meadow; highest floral availability
  81: 0.45,  // Pasture/Hay — clover, dandelion, weedy forbs
  82: 0.20,  // Cultivated Crops — weedy edges
  90: 0.35,  // Woody Wetlands — buttonbush, swamp rose, cardinal flower
  95: 0.65,  // Emergent Herbaceous Wetlands — cattail pollen, emergent flowers
};

/**
 * Guild-specific mean foraging ranges in km.
 * Sources: Greenleaf et al. 2007 (body-size allometry); Walther-Hellwig 2000;
 * Knight et al. 2005; Gathmann & Tscharntke 2002.
 *   Small: Lasioglossum, Andrena, Halictidae spp.    ≈ 150–500 m, median 300 m
 *   Medium: Megachilidae (leafcutters, mason bees)   ≈ 400–1000 m, median 700 m
 *   Large: Bumble bees (Bombus spp.)                 ≈ 700–2500 m, median 1500 m
 */
export const INVEST_GUILD_RANGES_KM = [0.30, 0.70, 1.50];

/**
 * Computes the Lonsdorf pollinator abundance index for the analysis grid.
 *
 * Returns a GeoJSON FeatureCollection where each point carries a `weight`
 * property (0–1, normalized). Used directly as input to the InVEST heatmap layer.
 *
 * @param {Map<string, {counts: object, total: number}>} gridData
 *   NLCD pixel counts per grid cell — from fetchGridNlcdScores().
 * @param {number} centerLng
 * @param {number} centerLat
 * @param {number} radiusKm
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeInVESTHeatmap(gridData, centerLng, centerLat, radiusKm) {
  const DEG_LNG_KM = 111.32 * Math.cos(centerLat * Math.PI / 180);
  const DEG_LAT_KM = 111.32;

  // Build array of valid, non-water-dominated cells with N and F scores.
  const cells = [];
  for (const [key, data] of gridData) {
    const [lngStr, latStr] = key.split(',');
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    const { counts, total } = data;

    if (!total) continue;

    // Exclude cells dominated (>50%) by open water — unsuitable for pollinators.
    if ((counts[11] ?? 0) / total > 0.50) continue;

    // N(x): weighted mean nesting suitability across NLCD classes present.
    let nestSum = 0;
    for (const [code, n] of Object.entries(counts)) {
      if (n > 0) nestSum += (INVEST_NESTING[+code] ?? 0.10) * (n / total);
    }

    // F(x): weighted mean floral resource score across NLCD classes present.
    let floralSum = 0;
    for (const [code, n] of Object.entries(counts)) {
      if (n > 0) floralSum += (INVEST_FLORAL[+code] ?? 0.15) * (n / total);
    }

    cells.push({ lng, lat, nest: nestSum, floral: floralSum, p: 0 });
  }

  if (!cells.length) return { type: 'FeatureCollection', features: [] };

  // Foraging sum: P(x) = N(x) × (1/G) × Σ_guild Σ_j [ F(j) × e^(−D/α) ]
  // Early-cutoff: skip cell pairs where D > 3×α (e^−3 ≈ 0.05, negligible).
  const G = INVEST_GUILD_RANGES_KM.length;

  for (let i = 0; i < cells.length; i++) {
    const xi = cells[i];
    let guildsTotal = 0;

    for (const alpha of INVEST_GUILD_RANGES_KM) {
      const cutoff = alpha * 3; // km
      let foragingSum = 0;

      for (let j = 0; j < cells.length; j++) {
        const xj = cells[j];
        const dLng = (xj.lng - xi.lng) * DEG_LNG_KM;
        const dLat = (xj.lat - xi.lat) * DEG_LAT_KM;
        // Quick bounding-box pre-filter before sqrt
        if (Math.abs(dLng) > cutoff || Math.abs(dLat) > cutoff) continue;
        const dist = Math.sqrt(dLng * dLng + dLat * dLat);
        if (dist > cutoff) continue;
        foragingSum += xj.floral * Math.exp(-dist / alpha);
      }

      guildsTotal += foragingSum;
    }

    xi.p = xi.nest * (guildsTotal / G);
  }

  // Normalize to 0–1 relative index.
  const maxP = Math.max(...cells.map(c => c.p));
  if (!maxP) return { type: 'FeatureCollection', features: [] };

  // Floor: cells below 8% of peak are omitted — removes noise at map edges.
  const floor = maxP * 0.08;

  return {
    type: 'FeatureCollection',
    features: cells
      .filter(c => c.p > floor)
      .map(c => ({
        type: 'Feature',
        geometry:   { type: 'Point', coordinates: [c.lng, c.lat] },
        properties: { weight: c.p / maxP },
      })),
  };
}
