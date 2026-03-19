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
