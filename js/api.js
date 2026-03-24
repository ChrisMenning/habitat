/**
 * api.js — iNaturalist API access and GeoJSON conversion.
 *
 * No DOM, no map. All functions are independently testable.
 * The only side-effect is `fetch()`.
 */

import { CENTER, RADIUS_KM, WI_PLACE_ID, PER_PAGE, MAX_OBS, ESTABLISHMENT } from './config.js';
import { classifyObs, getEstKey } from './classify.js';

const INAT_API_BASE = 'https://api.inaturalist.org/v1/observations';

// ── Fetching ─────────────────────────────────────────────────────────────────

/**
 * Fetches all available observations near Green Bay using cursor-based
 * pagination (id_below), stopping when there are no more results or when
 * MAX_OBS is reached.
 *
 * Cursor pagination avoids the HTTP 404 that the iNat v1 API returns when
 * requesting high `page` numbers against large result sets. We sort by `id`
 * descending and pass the minimum id from each batch as `id_below` for the
 * next request — this is the pattern documented in the iNat API reference.
 *
 * @param {string|undefined} d1          - start date (YYYY-MM-DD), optional
 * @param {string|undefined} d2          - end date (YYYY-MM-DD), optional
 * @param {function(number, number): void} [onProgress]
 *   Called after each page with (loadedSoFar, totalAvailable).
 * @returns {Promise<{observations: object[], total: number}>}
 */
export async function fetchObservations(d1, d2, onProgress) {
  const all = [];
  let total   = 0;
  let idBelow = null;

  while (all.length < MAX_OBS) {
    const params = new URLSearchParams({
      lat:                CENTER[1],
      lng:                CENTER[0],
      radius:             RADIUS_KM,
      per_page:           PER_PAGE,
      order:              'desc',
      order_by:           'id',        // required for id_below cursor to work
      // preferred_place_id sets Wisconsin context for establishment_means and
      // regional common names WITHOUT restricting results geographically.
      preferred_place_id: WI_PLACE_ID,
    });
    params.append('has[]', 'geo');
    if (d1)      params.set('d1',       d1);
    if (d2)      params.set('d2',       d2);
    if (idBelow) params.set('id_below', String(idBelow));

    const res = await fetch(`${INAT_API_BASE}?${params}`);
    if (!res.ok) {
      throw new Error(`iNaturalist API error: ${res.status} ${res.statusText}`);
    }

    const data    = await res.json();
    total         = data.total_results ?? total;
    const results = data.results ?? [];

    if (results.length === 0) break;

    all.push(...results);
    onProgress?.(all.length, total);

    if (results.length < PER_PAGE) break; // last page — no more to fetch

    // The cursor for the next request is the smallest id in this batch
    idBelow = Math.min(...results.map(r => r.id));
  }

  return { observations: all, total };
}

/**
 * Fetches observations for a single calendar year, using the server-side
 * history proxy (/api/inat-history/:year) when available.  The proxy
 * pre-warms its cache on server startup, so most requests are instant.
 * Falls back to direct iNaturalist API if the proxy is unreachable.
 *
 * The returned observations are in the same format as fetchObservations() and
 * are ready to be passed to observationsToGeoJSON().
 *
 * @param {number} year
 * @returns {Promise<{observations: object[], total: number}>}
 */
export async function fetchObservationsForYear(year) {
  try {
    const resp = await fetch(`/api/inat-history/${year}`);
    if (resp.ok) {
      const observations = await resp.json();
      if (Array.isArray(observations)) {
        return { observations, total: observations.length };
      }
    }
  } catch { /* proxy not available — fall through to direct API */ }

  // Direct fallback: query iNat with date bounds for this year
  const d1 = `${year}-01-01`;
  const d2 = `${year}-12-31`;
  return fetchObservations(d1, d2);
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
