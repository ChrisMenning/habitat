/**
 * ebird.js — Cornell Lab of Ornithology eBird recent observations.
 *
 * Fetches bird sightings within RADIUS_KM of the map center using eBird's
 * /data/obs/geo/recent endpoint, proxied through /api/ebird on the local
 * serve.js to keep the API key server-side.
 *
 * Observations are converted to GeoJSON features compatible with the existing
 * sightings layers so they can be time-filtered, highlighted in the drawer,
 * and counted in the intel bar.
 *
 * Date field: 'obsDt' (YYYY-MM-DD HH:MM) → normalised to 'date' (YYYY-MM-DD).
 *
 * No DOM. No map. All functions are independently testable.
 */

/**
 * Fetch eBird recent observations near the map center.
 * Returns them as a GeoJSON FeatureCollection.
 *
 * @param {number} [backDays=30]  Number of days back to query (eBird max 30).
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchEbirdObservations(backDays = 30) {
  const params = new URLSearchParams({ back: Math.min(30, backDays) });
  const res = await fetch(`/api/ebird?${params}`);
  if (!res.ok) {
    throw new Error(`eBird proxy error: ${res.status} ${res.statusText}`);
  }
  const records = await res.json();
  // serve.js returns { available: false } when no eBird API key is configured
  if (!Array.isArray(records)) {
    if (records.available === false) {
      console.info('eBird: no API key configured — skipping layer.');
    }
    return { type: 'FeatureCollection', features: [] };
  }
  return ebirdToGeoJSON(records);
}

/**
 * Convert raw eBird observation records to GeoJSON features.
 * Property schema matches the iNat observation shape so the same
 * drawer, histogram, and filter logic applies.
 *
 * eBird record fields used:
 *   speciesCode, comName, sciName, obsDt, lat, lng, locName,
 *   howMany, subId, locId
 *
 * @param {object[]} records
 * @returns {GeoJSON.FeatureCollection}
 */
export function ebirdToGeoJSON(records) {
  const features = [];
  for (const r of records) {
    const lat = r.lat ?? r.latitude;
    const lng = r.lng ?? r.longitude;
    if (!lat || !lng) continue;

    // Normalise obsDt "YYYY-MM-DD HH:MM" → "YYYY-MM-DD"
    const date = r.obsDt ? r.obsDt.slice(0, 10) : null;

    features.push({
      type:     'Feature',
      geometry: { type: 'Point', coordinates: [+lng, +lat] },
      properties: {
        // Core display fields shared with iNat/GBIF sightings
        id:        r.subId ?? r.checklistId,
        name:      r.sciName  ?? '',
        common:    r.comName  ?? '',
        date,
        layer_id:  'ebird',
        // eBird-specific
        how_many:  r.howMany ?? null,
        loc_name:  r.locName ?? '',
        loc_id:    r.locId   ?? '',
        species_code: r.speciesCode ?? '',
        url: r.subId
          ? `https://ebird.org/checklist/${r.subId}`
          : `https://ebird.org/species/${r.speciesCode ?? ''}`,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
