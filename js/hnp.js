/**
 * hnp.js — Homegrown National Park biodiversity planting data.
 *
 * Fetches registered native planting yards from the public HNP guest API and
 * filters them to the app's bounding box (Green Bay region).
 *
 * API endpoint: https://map.homegrownnationalpark.org/api/guest/map/plantings
 * Requires countryCode=US query parameter.
 * Returns: [{id, latitude, longitude, type}, ...]
 *   type values: "ORGANIZATIONS" | "OTHER_INVIDIUALS"  (typo is in the API)
 *
 * No auth required — the /api/guest/ prefix routes are publicly accessible.
 * Their own client caches for 15 minutes; we cache for 24 h in the app.
 *
 * The HNP API has no CORS headers, so browser requests would be blocked.
 * serve.js proxies GET /api/hnp-plantings → HNP upstream, adding CORS headers.
 */

import { CENTER, RADIUS_KM } from './config.js';

const [LNG, LAT] = CENTER;
const DEG_PER_KM_LAT = 1 / 111.32;
const DEG_PER_KM_LNG = 1 / (111.32 * Math.cos(LAT * Math.PI / 180));

// Expand the region bbox slightly (1.5×) so yards near the boundary are included
const MARGIN = 1.5;

const BBOX = {
  minLat: LAT - RADIUS_KM * MARGIN * DEG_PER_KM_LAT,
  maxLat: LAT + RADIUS_KM * MARGIN * DEG_PER_KM_LAT,
  minLng: LNG - RADIUS_KM * MARGIN * DEG_PER_KM_LNG,
  maxLng: LNG + RADIUS_KM * MARGIN * DEG_PER_KM_LNG,
};

const HNP_API = '/api/hnp-plantings';

/**
 * Fetches HNP registered native planting yards and returns a GeoJSON
 * FeatureCollection filtered to the app's bounding box.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchHnpYards() {
  const res = await fetch(HNP_API);
  if (!res.ok) throw new Error(`HNP API failed: ${res.status}`);

  const data = await res.json();
  if (!data || !Array.isArray(data.features)) throw new Error('HNP API returned unexpected format');

  const features = data.features
    .filter(f => {
      if (!f.geometry?.coordinates) return false;
      const [lng, lat] = f.geometry.coordinates;
      return (
        lat >= BBOX.minLat && lat <= BBOX.maxLat &&
        lng >= BBOX.minLng && lng <= BBOX.maxLng
      );
    })
    .map(f => {
      const p = f.properties;
      const isOrg = p.org_type === 'ORGANIZATIONS';
      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          ...p,                        // guest API fields: id, type (org_type alias added below)
          data_source: 'hnp',
          layer_id:    'hnp',
          est_key:     'hnp',
          hnp_id:      p.id,
          name:        p.name || p.org_name ||
                         (isOrg ? 'HNP Member Organization' : 'Homegrown National Park Yard'),
          hnp_map_url: 'https://map.homegrownnationalpark.org/',
        },
      };
    });

  return { type: 'FeatureCollection', features };
}
