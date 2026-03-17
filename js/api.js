/**
 * api.js — iNaturalist API access and GeoJSON conversion.
 *
 * No DOM, no map. All functions are independently testable.
 * The only side-effect is `fetch()`.
 */

import { CENTER, RADIUS_KM, WI_PLACE_ID, PER_PAGE, MAX_PAGES, ESTABLISHMENT } from './config.js';
import { classifyObs, getEstKey } from './classify.js';

const INAT_API_BASE = 'https://api.inaturalist.org/v1/observations';

// ── Fetching ─────────────────────────────────────────────────────────────────

/**
 * Fetches one page of geo-tagged observations near Green Bay.
 *
 * @param {number} page           - 1-based page number
 * @param {string|undefined} d1   - start date (YYYY-MM-DD), optional
 * @param {string|undefined} d2   - end date (YYYY-MM-DD), optional
 * @returns {Promise<{results: object[], total_results: number}>}
 * @throws {Error} if the network request fails or the server returns an error status
 */
async function fetchPage(page, d1, d2) {
  const params = new URLSearchParams({
    lat:      CENTER[1],
    lng:      CENTER[0],
    radius:   RADIUS_KM,
    per_page: PER_PAGE,
    page,
    order:    'desc',
    order_by: 'observed_on',
    // NOTE: place_id is intentionally omitted here.
    //
    // When provided, it acts as a geographic *filter* (AND with lat/lng/radius)
    // AND as context for taxon.establishment_means. Using it as a filter is
    // harmless when the search area is fully inside the place, but an incorrect
    // place_id (or one whose polygon doesn't cleanly contain the radius) will
    // silently return zero results. Omitting it avoids that fragility.
    //
    // Without place_id the API still returns establishment_means but relative
    // to broader global/national data. Our getEstKey() handles absent values
    // gracefully by returning 'unknown'.
    //
    // To re-enable: add  place_id: WI_PLACE_ID  (verify the correct ID first
    // at https://www.inaturalist.org/places/wisconsin).
  });
  params.append('has[]', 'geo');
  if (d1) params.set('d1', d1);
  if (d2) params.set('d2', d2);

  const res = await fetch(`${INAT_API_BASE}?${params}`);
  if (!res.ok) {
    throw new Error(`iNaturalist API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Fetches all configured pages of observations in parallel.
 *
 * @param {string|undefined} d1 - start date (YYYY-MM-DD), optional
 * @param {string|undefined} d2 - end date (YYYY-MM-DD), optional
 * @returns {Promise<{observations: object[], total: number}>}
 */
export async function fetchObservations(d1, d2) {
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, i) => fetchPage(i + 1, d1, d2))
  );
  return {
    observations: pages.flatMap(p => p.results),
    total:        pages[0].total_results ?? 0,
  };
}

// ── GeoJSON conversion ───────────────────────────────────────────────────────

/**
 * Converts an array of iNaturalist observations to a GeoJSON FeatureCollection.
 *
 * Feature properties contain ONLY string/number primitives. In particular,
 * no hex color strings are stored as properties. Colors are resolved at
 * render time via MapLibre `match` expressions in layers.js, which avoids
 * the tile-worker null-type error present in MapLibre 4.x when color values
 * cross the postMessage serialization boundary.
 *
 * @param {object[]} observations
 * @returns {GeoJSON.FeatureCollection}
 */
export function observationsToGeoJSON(observations) {
  return {
    type: 'FeatureCollection',
    features: observations
      .filter(obs => Boolean(obs.location))
      .map(obs => {
        const [lat, lng] = obs.location.split(',').map(Number);
        const estKey     = getEstKey(obs);
        const estLabel   = (ESTABLISHMENT[estKey] ?? ESTABLISHMENT.unknown).label;

        return {
          type: 'Feature',
          geometry: {
            type:        'Point',
            coordinates: [lng, lat],
          },
          properties: {
            id:        obs.id,
            name:      obs.taxon?.name                      ?? 'Unknown',
            common:    obs.taxon?.preferred_common_name     ?? '',
            date:      obs.observed_on                      ?? '',
            user:      obs.user?.login                      ?? '',
            image:     obs.taxon?.default_photo?.medium_url ?? '',
            url:       `https://www.inaturalist.org/observations/${obs.id}`,
            // String enum properties — used in MapLibre match expressions
            layer_id:  classifyObs(obs),
            est_key:   estKey,
            // Human-readable label for the popup (main-thread only, not tile worker)
            est_label: estLabel,
          },
        };
      }),
  };
}

/**
 * Partitions a GeoJSON FeatureCollection's features into per-layer buckets.
 *
 * @param {GeoJSON.FeatureCollection} geojson
 * @param {string[]} layerIds
 * @returns {Record<string, GeoJSON.Feature[]>}
 */
export function partitionByLayer(geojson, layerIds) {
  const buckets = Object.fromEntries(layerIds.map(id => [id, []]));
  for (const feature of geojson.features) {
    const lid = feature.properties.layer_id;
    if (lid in buckets) buckets[lid].push(feature);
  }
  return buckets;
}
