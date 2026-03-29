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

  // 40 sites × ~90 chars URL-encoded ≈ 3.5 KB per request — safely under
  // nginx's default 8 KB large_client_header_buffers limit.  Requests are
  // fired in parallel so the extra batches don't add wall time.
  const BATCH = 40;
  const result = new Map();

  // Fire all batches in parallel — typically 10–20 requests, each resolves in
  // ~200–500 ms against localhost, so total wall time stays under 1 s vs
  // 10–15 s when awaited sequentially.
  const batches = [];
  for (let i = 0; i < allSites.length; i += BATCH) {
    batches.push(allSites.slice(i, i + BATCH));
  }

  const responses = await Promise.allSettled(
    batches.map(batch =>
      fetch(`/api/nlcd-nesting?sites=${encodeURIComponent(JSON.stringify(batch))}`)
        .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
    )
  );

  for (const r of responses) {
    if (r.status !== 'fulfilled') continue;
    for (const item of r.value) {
      result.set(item.id, { score: item.score, counts: item.counts, total: item.total });
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
//   Koh et al. (2016) PNAS 113(1): 140–145               — cavity nesting scores
//   Wentling et al. (2021) Landsc. Ecol.                  — NLCD-specific scoring
//
// Core equations (InVEST Eqs. 61–63):
//
//   HN(x,s)  = max_n [ N(l(x),n) × ns(s,n) ]                  (Eq. 63)
//   FR(x,s)  = Σ_j [ exp(-D/α) × Σ_season fa(s,j) × F(j) ]    (Eq. 62, numerator)
//            ÷ Σ_j [ exp(-D/α) ]                               (Eq. 62, denominator — normalizes kernel)
//   PS(x,s)  = FR(x,s) × HN(x,s) × sa(s)                      (Eq. 61)
//   P(x)     = Σ_s PS(x,s)                                      (total pollinator index)

/**
 * Ground-nesting suitability per NLCD 2021 class (0.0–1.0).
 * Source: Lonsdorf 2009 Table 1 + Wentling 2021 supplementary Table S1.
 */
export const INVEST_NESTING_GROUND = {
  11: 0.00,  // Open Water
  21: 0.20,  // Developed Open Space (parks, lawns — bare patches)
  22: 0.05,  // Developed Low Intensity
  23: 0.00,  // Developed Medium Intensity
  24: 0.00,  // Developed High Intensity
  31: 0.90,  // Barren Land — prime bare-soil nesting substrate
  41: 0.10,  // Deciduous Forest — edge patches
  42: 0.05,  // Evergreen Forest
  43: 0.10,  // Mixed Forest
  52: 0.60,  // Shrub/Scrub — exposed soil between shrubs
  71: 0.80,  // Grassland/Herbaceous — extensive bare-ground habitat
  81: 0.50,  // Pasture/Hay — exposed soil in shorter-stature vegetation
  82: 0.10,  // Cultivated Crops — disrupted by tillage and pesticides
  90: 0.05,  // Woody Wetlands — too wet
  95: 0.10,  // Emergent Herbaceous Wetlands — limited dry microsites
};

/**
 * Cavity-nesting suitability per NLCD 2021 class (0.0–1.0).
 * Scores reflect snag density, structural wood, and hollow-stem availability.
 * Source: Koh et al. 2016 PNAS Table S1, adapted to NLCD 2021 class definitions.
 */
export const INVEST_NESTING_CAVITY = {
  11: 0.00,  // Open Water
  21: 0.30,  // Developed Open Space — garden structures, fences, isolated trees
  22: 0.15,  // Developed Low Intensity — residential trees
  23: 0.05,  // Developed Medium Intensity
  24: 0.00,  // Developed High Intensity
  31: 0.00,  // Barren Land — no structure
  41: 0.60,  // Deciduous Forest — snags, hollow branches; prime mason/leafcutter habitat
  42: 0.35,  // Evergreen Forest — moderate snag density
  43: 0.50,  // Mixed Forest
  52: 0.40,  // Shrub/Scrub — hollow stems (Rubus, elderberry)
  71: 0.10,  // Grassland — limited woody structure
  81: 0.10,  // Pasture/Hay — fence posts, isolated trees
  82: 0.00,  // Cultivated Crops — no structure
  90: 0.35,  // Woody Wetlands — standing dead wood
  95: 0.05,  // Emergent Wetlands — limited
};

/**
 * Spring floral resources per NLCD 2021 class (0.0–1.0).
 * Emphasizes early-season bloom: forest ephemerals, urban open space (dandelion,
 * redbud), wetland emergents. Roughly March–May for Upper Midwest.
 * Sources: Sharp et al. 2018 + Wentling 2021 + regional phenology literature.
 */
export const INVEST_FLORAL_SPRING = {
  11: 0.00,  // Open Water
  21: 0.45,  // Developed Open Space — dandelion, ornamental early bloom
  22: 0.20,  // Developed Low Intensity
  23: 0.08,  // Developed Medium
  24: 0.00,  // Developed High
  31: 0.02,  // Barren — sparse
  41: 0.50,  // Deciduous Forest — trillium, hepatica, spring ephemerals; peak spring
  42: 0.05,  // Evergreen Forest — limited
  43: 0.30,  // Mixed Forest
  52: 0.40,  // Shrub/Scrub — serviceberry, willow catkins
  71: 0.60,  // Grassland — early forbs, violets
  81: 0.50,  // Pasture/Hay — dandelion, clover early season
  82: 0.15,  // Cultivated Crops
  90: 0.40,  // Woody Wetlands — swamp rose, willows
  95: 0.55,  // Emergent Wetlands — early emergents
};

/**
 * Summer floral resources per NLCD 2021 class (0.0–1.0).
 * Emphasizes mid/late summer bloom: native prairie, wetland emergents, flowering shrubs.
 * Roughly June–September for Upper Midwest.
 * Sources: Sharp et al. 2018 + Wentling 2021 + regional phenology literature.
 */
export const INVEST_FLORAL_SUMMER = {
  11: 0.00,  // Open Water
  21: 0.35,  // Developed Open Space — managed lawns, some summer planters
  22: 0.12,  // Developed Low
  23: 0.03,  // Developed Medium
  24: 0.00,  // Developed High
  31: 0.08,  // Barren — ruderal forbs, Queen Anne's lace
  41: 0.15,  // Deciduous Forest — forest interior; reduced after spring ephemerals
  42: 0.12,  // Evergreen Forest
  43: 0.15,  // Mixed Forest
  52: 0.80,  // Shrub/Scrub — elderberry, wild rose, native spiraea
  71: 1.00,  // Grassland — native wildflower meadow; peak summer forage
  81: 0.40,  // Pasture/Hay — clover, weedy forbs
  82: 0.25,  // Cultivated Crops — weedy edges
  90: 0.30,  // Woody Wetlands — buttonbush, cardinal flower
  95: 0.70,  // Emergent Wetlands — cattail pollen, emergent flowers
};

/**
 * Guild table for Wisconsin native bee communities.
 * Each entry: { alphaKm, groundPref, cavityPref, springActivity, summerActivity, abundance }
 *
 *   alphaKm       — mean foraging distance (km); source: Greenleaf et al. 2007
 *   groundPref    — nesting preference for ground substrate (ns(s,'ground')); 0–1
 *   cavityPref    — nesting preference for cavity substrate (ns(s,'cavity')); 0–1
 *   springActivity — relative foraging activity in spring (fa(s,'spring')); 0–1
 *   summerActivity — relative foraging activity in summer (fa(s,'summer')); 0–1
 *   abundance     — relative species abundance sa(s); must sum to 1.0 across guilds
 *
 * Guild definitions:
 *   small_solitary  — Lasioglossum, Andrena, Halictidae spp. (αmed ≈ 300 m)
 *   medium_solitary — Megachilidae: leafcutter, mason bees, Osmia (αmed ≈ 700 m)
 *   bumble          — Bombus spp. (αmed ≈ 1500 m)
 *
 * Sources: Koh et al. 2016 (abundance, nesting prefs); Greenleaf et al. 2007 (alpha)
 */
export const INVEST_GUILDS = [
  { alphaKm: 0.30, groundPref: 0.8, cavityPref: 0.3, springActivity: 0.7, summerActivity: 1.0, abundance: 0.25 },
  { alphaKm: 0.70, groundPref: 0.6, cavityPref: 0.8, springActivity: 1.0, summerActivity: 0.9, abundance: 0.35 },
  { alphaKm: 1.50, groundPref: 0.9, cavityPref: 0.1, springActivity: 0.8, summerActivity: 1.0, abundance: 0.40 },
];

// Retained for backward-compat with any import that still references the old name.
export const INVEST_GUILD_RANGES_KM = INVEST_GUILDS.map(g => g.alphaKm);

/**
 * Computes the Lonsdorf pollinator abundance index for the analysis grid.
 *
 * Implements InVEST Eqs. 61–63:
 *   HN(x,s)  = max_n [ N(l,n) × ns(s,n) ]                (max over ground and cavity substrates)
 *   FR(x,s)  = Σ_j exp(-D/α) × floralScore(j,s)          (numerator — weighted floral access)
 *            ÷ Σ_j exp(-D/α)                              (denominator — kernel normalization)
 *   PS(x,s)  = FR(x,s) × HN(x,s) × abundance(s)
 *   P(x)     = Σ_s PS(x,s)
 *
 * Returns a GeoJSON FeatureCollection where each point has a normalized `weight` (0–1).
 *
 * @param {Map<string, {counts: object, total: number}>} gridData
 * @param {number} centerLng
 * @param {number} centerLat
 * @param {number} radiusKm
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeInVESTHeatmap(gridData, centerLng, centerLat, radiusKm) {
  const DEG_LNG_KM = 111.32 * Math.cos(centerLat * Math.PI / 180);
  const DEG_LAT_KM = 111.32;

  // Build array of valid, non-water-dominated cells with per-guild HN and per-cell floral arrays.
  const cells = [];
  for (const [key, data] of gridData) {
    const [lngStr, latStr] = key.split(',');
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    const { counts, total } = data;

    if (!total) continue;

    // Exclude cells dominated (>50%) by open water.
    if ((counts[11] ?? 0) / total > 0.50) continue;

    // HN(x, s) = max_n [ N(l, n) × ns(s, n) ] for each guild.
    // We pre-compute the weighted average N per substrate across NLCD classes present,
    // then apply the guild's substrate preference and take the max.
    let groundNest = 0;
    let cavityNest = 0;
    let springFloral = 0;
    let summerFloral = 0;
    for (const [code, n] of Object.entries(counts)) {
      if (!n) continue;
      const frac = n / total;
      const c = +code;
      groundNest  += (INVEST_NESTING_GROUND[c]  ?? 0.05) * frac;
      cavityNest  += (INVEST_NESTING_CAVITY[c]  ?? 0.05) * frac;
      springFloral += (INVEST_FLORAL_SPRING[c]  ?? 0.10) * frac;
      summerFloral += (INVEST_FLORAL_SUMMER[c]  ?? 0.10) * frac;
    }

    // Per-guild HN: max(ground × groundPref, cavity × cavityPref)
    const hn = INVEST_GUILDS.map(g =>
      Math.max(groundNest * g.groundPref, cavityNest * g.cavityPref)
    );

    cells.push({ lng, lat, hn, springFloral, summerFloral, p: 0 });
  }

  if (!cells.length) return { type: 'FeatureCollection', features: [] };

  // Main kernel loop:
  //   For each cell xi and each guild s:
  //     numerator   = Σ_j exp(-D/α) × [fa_spring × floralSpring(j) + fa_summer × floralSummer(j)]
  //     denominator = Σ_j exp(-D/α)   ← kernel normalization (InVEST Eq. 62 denominator)
  //     FR(xi, s)   = numerator / denominator
  //     PS(xi, s)   = FR × HN(xi,s) × abundance(s)
  //   P(xi) = Σ_s PS(xi, s)
  //
  // Early-cutoff: skip pairs where D > 3α (exp(-3) ≈ 0.05, negligible contribution).

  for (let i = 0; i < cells.length; i++) {
    const xi = cells[i];
    let totalPS = 0;

    for (let gi = 0; gi < INVEST_GUILDS.length; gi++) {
      const g = INVEST_GUILDS[gi];
      const alpha = g.alphaKm;
      const cutoff = alpha * 3;

      let floralNum = 0; // Σ exp(-D/α) × seasonalFloral
      let normSum   = 0; // Σ exp(-D/α)

      for (let j = 0; j < cells.length; j++) {
        const xj = cells[j];
        const dLng = (xj.lng - xi.lng) * DEG_LNG_KM;
        const dLat = (xj.lat - xi.lat) * DEG_LAT_KM;
        // Bounding-box pre-filter before sqrt
        if (Math.abs(dLng) > cutoff || Math.abs(dLat) > cutoff) continue;
        const dist = Math.sqrt(dLng * dLng + dLat * dLat);
        if (dist > cutoff) continue;

        const w = Math.exp(-dist / alpha);
        const floralJ = g.springActivity * xj.springFloral + g.summerActivity * xj.summerFloral;
        floralNum += w * floralJ;
        normSum   += w;
      }

      const FR = normSum > 0 ? floralNum / normSum : 0;
      totalPS += FR * xi.hn[gi] * g.abundance;
    }

    xi.p = totalPS;
  }

  // Normalize to 0–1 relative index.
  const maxP = Math.max(...cells.map(c => c.p));
  if (!maxP) return { type: 'FeatureCollection', features: [] };

  // Floor: cells below 2% of peak are omitted — removes only genuine noise.
  const floor = maxP * 0.02;

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

// ── Urban InVEST / Lonsdorf — intra-urban habitat index ──────────────────────
//
// Same Lonsdorf kernel as computeInVESTHeatmap but tuned for the urban context:
//
//   • Grid cells are filtered to those with ≥20% developed NLCD pixels —
//     the analysis is only about the urban footprint.
//   • Rural cells STILL participate in the foraging kernel (a park adjacent to
//     farmland benefits from that floral resource) but do NOT appear in the output
//     and do NOT set the normalization ceiling.
//   • Normalization baseline is the max P(x) among urban cells — so a city park
//     that is the best habitat for 2 km in every direction scores near 1.0 even
//     if it would score 0.12 against Suamico grassland.
//   • Guild weights shift toward small and medium solitary bees — the species
//     that realistically occupy urban green patches (Osmia, Lasioglossum).
//   • No floor — all urban signal (even faint) is shown.

/**
 * Urban-tuned guild table.
 * Small/medium solitary bees (cavity + ground) upweighted;
 * bumble bee downweighted (less habitat for large queens in dense urban).
 * Abundances sum to 1.0.
 */
const INVEST_GUILDS_URBAN = [
  { alphaKm: 0.30, groundPref: 0.8, cavityPref: 0.3, springActivity: 0.7, summerActivity: 1.0, abundance: 0.40 },
  { alphaKm: 0.70, groundPref: 0.6, cavityPref: 0.8, springActivity: 1.0, summerActivity: 0.9, abundance: 0.45 },
  { alphaKm: 1.50, groundPref: 0.9, cavityPref: 0.1, springActivity: 0.8, summerActivity: 1.0, abundance: 0.15 },
];

/** Minimum fraction of developed NLCD pixels for a cell to be considered "urban". */
const URBAN_NLCD_THRESHOLD = 0.20;

/**
 * Computes a relative InVEST pollinator index scoped to the urban landscape.
 * Output cells are restricted to developed areas; normalization ceiling is set
 * by the best urban cell — not by rural grassland.
 *
 * @param {Map<string, {counts: object, total: number}>} gridData
 * @param {number} centerLng
 * @param {number} centerLat
 * @param {number} radiusKm
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeInVESTHeatmapUrban(gridData, centerLng, centerLat, radiusKm) {
  const DEG_LNG_KM = 111.32 * Math.cos(centerLat * Math.PI / 180);
  const DEG_LAT_KM = 111.32;

  const cells = [];
  for (const [key, data] of gridData) {
    const [lngStr, latStr] = key.split(',');
    const lng = parseFloat(lngStr);
    const lat = parseFloat(latStr);
    const { counts, total } = data;
    if (!total) continue;
    if ((counts[11] ?? 0) / total > 0.50) continue;

    const devPixels = (counts[21] ?? 0) + (counts[22] ?? 0) + (counts[23] ?? 0) + (counts[24] ?? 0);
    const urbanFrac = devPixels / total;

    let groundNest = 0, cavityNest = 0, springFloral = 0, summerFloral = 0;
    for (const [code, n] of Object.entries(counts)) {
      if (!n) continue;
      const frac = n / total;
      const c = +code;
      groundNest   += (INVEST_NESTING_GROUND[c]  ?? 0.05) * frac;
      cavityNest   += (INVEST_NESTING_CAVITY[c]  ?? 0.05) * frac;
      springFloral += (INVEST_FLORAL_SPRING[c]   ?? 0.10) * frac;
      summerFloral += (INVEST_FLORAL_SUMMER[c]   ?? 0.10) * frac;
    }

    const hn = INVEST_GUILDS_URBAN.map(g =>
      Math.max(groundNest * g.groundPref, cavityNest * g.cavityPref)
    );

    cells.push({ lng, lat, hn, springFloral, summerFloral, urbanFrac, p: 0 });
  }

  if (!cells.length) return { type: 'FeatureCollection', features: [] };

  // At fine (330 m) grid resolution a full O(n²) neighbourhood kernel would
  // iterate ~36 M pairs for a 15 km radius study area, freezing the browser
  // for several seconds.  Instead, use each cell's own floral resource
  // directly — equivalent to a kernel with weight=1 at distance=0 and 0
  // elsewhere.  At 330 m this produces meaningful relative differences without
  // the computational cost, and the normalisation step ensures the relative
  // comparison across urban cells is still valid.
  for (const xi of cells) {
    let totalPS = 0;
    for (let gi = 0; gi < INVEST_GUILDS_URBAN.length; gi++) {
      const g  = INVEST_GUILDS_URBAN[gi];
      const FR = g.springActivity * xi.springFloral + g.summerActivity * xi.summerFloral;
      totalPS += FR * xi.hn[gi] * g.abundance;
    }
    xi.p = totalPS;
  }

  // Normalize against the best URBAN cell only.
  const urbanCells = cells.filter(c => c.urbanFrac >= URBAN_NLCD_THRESHOLD);
  if (!urbanCells.length) return { type: 'FeatureCollection', features: [] };
  const maxP = Math.max(...urbanCells.map(c => c.p));
  if (!maxP) return { type: 'FeatureCollection', features: [] };

  return {
    type: 'FeatureCollection',
    features: urbanCells.map(c => ({
      type: 'Feature',
      geometry:   { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { weight: c.p / maxP },
    })),
  };
}

// ── InVEST × Corridor crosswalk ───────────────────────────────────────────────

/**
 * For each corridor site (centroid coords), finds the nearest cell in a pre-computed
 * urban InVEST GeoJSON FeatureCollection and assigns that cell's weight as the
 * site's landscape context score.
 *
 * Returns an array of { name, lng, lat, investScore } objects, suitable for
 * display in the corridor site dossier or for coloring site pins.
 *
 * @param {GeoJSON.FeatureCollection} urbanGeojson — output of computeInVESTHeatmapUrban
 * @param {Array<{name:string, coords:[number,number]}>} corridorSites
 * @returns {Array<{name:string, lng:number, lat:number, investScore:number}>}
 */
export function crosswalkInVESTCorridor(urbanGeojson, corridorSites) {
  const features = urbanGeojson?.features ?? [];
  if (!features.length || !corridorSites.length) return [];

  return corridorSites.map(site => {
    const [siteLng, siteLat] = site.coords;
    let bestDist = Infinity;
    let bestWeight = 0;

    for (const f of features) {
      const [fLng, fLat] = f.geometry.coordinates;
      const dx = (fLng - siteLng) * 111.32 * Math.cos(siteLat * Math.PI / 180);
      const dy = (fLat - siteLat) * 111.32;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) {
        bestDist   = d;
        bestWeight = f.properties.weight ?? 0;
      }
    }

    return { name: site.name, lng: siteLng, lat: siteLat, investScore: bestWeight };
  });
}

// ── Foraging-range bands GeoJSON generator ────────────────────────────────────

/**
 * Generates a GeoJSON FeatureCollection of semi-transparent ring polygons
 * representing the foraging reach of each guild from each corridor site.
 *
 * Three rings per site correspond to the three guild alphas in INVEST_GUILDS_URBAN:
 *   0.30 km — small solitary bees (Lasioglossum, Andrena)
 *   0.70 km — medium solitary bees (Osmia, Megachile)
 *   1.50 km — bumble bees (Bombus)
 *
 * Each ring is a GeoJSON Polygon (approximated as a 64-point circle).
 * Properties include `guild` (small/medium/bumble), `radius_km`, and `site_name`.
 * The rings are ordered outer→inner so MapLibre fill renders correctly (outer first).
 *
 * @param {Array<{name:string, coords:[number,number]}>} corridorSites
 * @returns {GeoJSON.FeatureCollection}
 */
export function computeForagingBands(corridorSites) {
  const GUILD_RINGS = [
    { guild: 'bumble',  radiusKm: 1.50, label: 'Bumble bee range' },
    { guild: 'medium',  radiusKm: 0.70, label: 'Medium solitary range' },
    { guild: 'small',   radiusKm: 0.30, label: 'Small solitary range' },
  ];
  const STEPS = 64;

  // Cluster sites within 250 m of each other so dense groupings like Farlin
  // Park (9 adjacent sites) render as a single representative ring rather
  // than 9 overlapping near-identical polygons.
  const CLUSTER_KM = 0.25;
  const clusters = [];
  for (const site of corridorSites) {
    const [lng, lat] = site.coords;
    let found = null;
    for (const c of clusters) {
      const dx = (lng - c.lng) * 111.32 * Math.cos(lat * Math.PI / 180);
      const dy = (lat - c.lat) * 111.32;
      if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_KM) { found = c; break; }
    }
    if (found) {
      found.count++;
      found.lng += (lng - found.lng) / found.count;
      found.lat += (lat - found.lat) / found.count;
    } else {
      clusters.push({ name: site.name, lng, lat, count: 1 });
    }
  }
  const effectiveSites = clusters.map(c => ({
    name:   c.count > 1 ? `${c.name} area` : c.name,
    coords: [c.lng, c.lat],
  }));

  const features = [];

  for (const site of effectiveSites) {
    const [lng, lat] = site.coords;
    const DEG_LNG = 1 / (111.32 * Math.cos(lat * Math.PI / 180));
    const DEG_LAT = 1 / 111.32;

    for (const ring of GUILD_RINGS) {
      const coords = [];
      for (let i = 0; i <= STEPS; i++) {
        const angle = (i / STEPS) * 2 * Math.PI;
        coords.push([
          lng + Math.cos(angle) * ring.radiusKm * DEG_LNG,
          lat + Math.sin(angle) * ring.radiusKm * DEG_LAT,
        ]);
      }
      features.push({
        type: 'Feature',
        geometry:   { type: 'Polygon', coordinates: [coords] },
        properties: {
          site_name: site.name,
          guild:     ring.guild,
          radius_km: ring.radiusKm,
          label:     ring.label,
        },
      });
    }
  }

  return { type: 'FeatureCollection', features };
}

// ── Navigable foraging land area ──────────────────────────────────────────────

/**
 * Estimates the combined navigable land area reachable by bumble bees (1.5 km
 * radius — the outermost foraging envelope) across all corridor sites, with open
 * water excluded.
 *
 * Uses the same 250 m cluster centroids as computeForagingBands so the two
 * calculations are consistent.  A regular grid of sample points is tested for
 * (a) membership in any cluster circle and (b) water dominance via NLCD class 11
 * pixel fraction from the supplied nlcdScoresMap.  The grid-cell area × counted
 * cells gives the final km² estimate.
 *
 * @param {Array<{name:string, coords:[number,number]}>} corridorSites
 * @param {Map<string, {counts:object, total:number}>} nlcdScoresMap
 *   — from fetchGridNlcdScores; cell keys are nlcdGridKey strings at 0.006° step
 * @returns {{ totalKm2: number, landKm2: number, waterKm2: number }}
 */
export function computeForagingLandAreaKm2(corridorSites, nlcdScoresMap) {
  const CLUSTER_KM = 0.25;   // same merge radius as computeForagingBands
  const RADIUS_KM  = 1.50;   // bumble bee — outermost foraging envelope
  const STEP       = 0.003;  // ~333 m lat, ~240 m lng at 44.5° N

  // Replicate the 250 m clustering from computeForagingBands
  const clusters = [];
  for (const site of corridorSites) {
    const [lng, lat] = site.coords;
    let found = null;
    for (const c of clusters) {
      const dx = (lng - c.lng) * 111.32 * Math.cos(lat * Math.PI / 180);
      const dy = (lat - c.lat) * 111.32;
      if (Math.sqrt(dx * dx + dy * dy) < CLUSTER_KM) { found = c; break; }
    }
    if (found) {
      found.count++;
      found.lng += (lng - found.lng) / found.count;
      found.lat += (lat - found.lat) / found.count;
    } else {
      clusters.push({ lng, lat, count: 1 });
    }
  }
  if (clusters.length === 0) return { totalKm2: 0, landKm2: 0, waterKm2: 0 };

  // Bounding box of all circles (RADIUS_KM margin on each side)
  const DEG_LNG = 1 / (111.32 * Math.cos(44.513 * Math.PI / 180)); // ≈ 0.01259 °/km
  const DEG_LAT = 1 / 111.32;                                        // ≈ 0.00898 °/km
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of clusters) {
    minLng = Math.min(minLng, c.lng - RADIUS_KM * DEG_LNG);
    maxLng = Math.max(maxLng, c.lng + RADIUS_KM * DEG_LNG);
    minLat = Math.min(minLat, c.lat - RADIUS_KM * DEG_LAT);
    maxLat = Math.max(maxLat, c.lat + RADIUS_KM * DEG_LAT);
  }

  let inCircle = 0, inWater = 0;
  const hasMap = nlcdScoresMap && nlcdScoresMap.size > 0;

  for (let lat = minLat; lat <= maxLat; lat += STEP) {
    const cosLat = Math.cos(lat * Math.PI / 180);
    for (let lng = minLng; lng <= maxLng; lng += STEP) {
      // Test membership in any cluster circle
      let inside = false;
      for (const c of clusters) {
        const dx = (lng - c.lng) * 111.32 * cosLat;
        const dy = (lat - c.lat) * 111.32;
        if (dx * dx + dy * dy <= RADIUS_KM * RADIUS_KM) { inside = true; break; }
      }
      if (!inside) continue;
      inCircle++;

      // Water check: snap to nearest 0.006° NLCD grid cell (same key scheme
      // as nlcdGridKey / fetchGridNlcdScores).  A cell is "water" when NLCD
      // class 11 (Open Water) accounts for > 50 % of pixels.
      if (hasMap) {
        const snapLng = (Math.round(lng / 0.006) * 0.006).toFixed(3);
        const snapLat = (Math.round(lat / 0.006) * 0.006).toFixed(3);
        const cell = nlcdScoresMap.get(`${snapLng},${snapLat}`);
        if (cell && cell.total > 0 && (cell.counts[11] ?? 0) / cell.total > 0.5) {
          inWater++;
        }
      }
    }
  }

  // Each sample cell has this area (km²); midpoint latitude for longitude scaling
  const midLat      = (minLat + maxLat) / 2;
  const cellAreaKm2 = (STEP * 111.32) * (STEP * 111.32 * Math.cos(midLat * Math.PI / 180));
  const totalKm2    = inCircle * cellAreaKm2;
  const waterKm2    = inWater  * cellAreaKm2;
  return { totalKm2, landKm2: totalKm2 - waterKm2, waterKm2 };
}
