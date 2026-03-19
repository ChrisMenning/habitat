/**
 * parcels.js — Brown County parcel ownership data.
 *
 * Provides lazy-loaded parcel GeoJSON, ownership classification, and
 * spatial query helpers used by the drawer, map layer, and alerts engine.
 *
 * Data source: Brown County GIS ArcGIS REST Feature Service (updated 2026)
 *   https://gis.browncountywi.gov/arcgis/rest/services/ParcelAndAddressFeatures/FeatureServer/23
 *   (old gis.co.brown.wi.us hostname is no longer resolvable)
 * Proxied at /api/parcels (Brown County GIS does not send CORS headers).
 *
 * Ownership classification uses the explicit PublicOwner field:
 *   null         → private
 *   'County'     → county (Brown County)
 *   'Municipal'  → city (if Municipality = 'CITY OF GREEN BAY') or institutional
 *   'State'      → state
 *   'Other'      → institutional
 *
 * Note: this layer does not contain street addresses or owner names.
 * Municipality (city/town name) is used as the location field.
 */

// ── Ownership classification ──────────────────────────────────────────────────

/**
 * @typedef {'city'|'county'|'state'|'institutional'|'private'} OwnerClass
 */

/** Visible label and map fill color for each ownership class. */
export const OWNERSHIP_META = {
  city:          { label: 'City of Green Bay', color: '#0d9488', textColor: '#fff' },
  county:        { label: 'Brown County',       color: '#65a30d', textColor: '#fff' },
  state:         { label: 'State of Wisconsin', color: '#166534', textColor: '#fff' },
  institutional: { label: 'Institutional',      color: '#d97706', textColor: '#fff' },
  private:       { label: 'Private',            color: 'transparent', textColor: '#374151' },
};

/**
 * Classifies a parcel's ownership from its properties.
 * Uses the new Brown County schema (2026): PublicOwner + Municipality fields.
 *
 * PublicOwner values: null (private), 'County', 'Municipal', 'State', 'Other'
 * Municipality: 'CITY OF GREEN BAY', 'CITY OF DE PERE', 'TOWN OF LAWRENCE', etc.
 *
 * @param {object} props  GeoJSON feature properties
 * @returns {OwnerClass}
 */
export function classifyOwnership(props) {
  const pubOwner = props.PublicOwner ?? null;
  if (!pubOwner) return 'private';
  if (pubOwner === 'State')  return 'state';
  if (pubOwner === 'County') return 'county';
  if (pubOwner === 'Other')  return 'institutional';
  if (pubOwner === 'Municipal') {
    const muni = String(props.Municipality ?? '').toLowerCase();
    if (/city\s+of\s+green\s+bay|green\s+bay/.test(muni)) return 'city';
    return 'institutional';   // other city/village/town — still public but not Green Bay
  }
  return 'private';
}

/** Parse area-in-acres from MapAreaTxt: '0.264 AC' or '8,274 SF'. */
function _parseMapAreaAcres(txt) {
  if (!txt) return 0;
  const s = String(txt).replace(/,/g, '').trim();
  const acMatch = s.match(/^([\d.]+)\s*AC$/i);
  if (acMatch) return parseFloat(acMatch[1]);
  const sfMatch = s.match(/^([\d.]+)\s*SF$/i);
  if (sfMatch) return parseFloat(sfMatch[1]) / 43560;
  return 0;
}

/** Convert ALL-CAPS municipality name to title case. */
function _toTitleCase(str) {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extracts a human-readable parcel record from raw properties.
 * New schema (2026): uses PublicOwner + Municipality instead of owner name;
 * MapAreaTxt instead of CALCACRES; no street address in this layer.
 *
 * @param {object} props
 * @returns {{ owner:string, parcelId:string, address:string, acres:number }}
 */
export function normaliseParcelProps(props) {
  const pubOwner = props.PublicOwner ?? null;
  const muni     = String(props.Municipality ?? '').trim();
  const muniTC   = muni ? _toTitleCase(muni) : '';

  let owner = '—';
  if      (pubOwner === 'County')    owner = 'Brown County';
  else if (pubOwner === 'State')     owner = 'State of Wisconsin';
  else if (pubOwner === 'Municipal') owner = muniTC || 'Municipality';
  else if (pubOwner === 'Other')     owner = 'Public (Other)';
  // private: owner stays '—'

  return {
    owner,
    parcelId: String(props.PARCELID ?? '').trim() || '—',
    address:  muniTC || '—',   // municipality is the best available location context
    acres:    _parseMapAreaAcres(props.MapAreaTxt),
  };
}

// ── Fetch state ───────────────────────────────────────────────────────────────

// Viewport-gated fetching: the county ArcGIS server times out for county-wide
// requests. Instead we fetch only the bbox currently visible on screen, which
// at zoom ≥ 13 is typically 200–600 features and responds in 1–3 s.
//
// Features are accumulated in _features across viewport changes (keyed by
// PARCELID to avoid storing duplicates when the user pans slightly).

/** @type {'idle'|'loading'|'ready'|'error'} */
let _state    = 'idle';
let _features = [];          // GeoJSON Feature[]  (accumulated across fetches)
const _seenIds = new Set();  // PARCELID deduplication

/**
 * Returns the current fetch state.
 * @returns {'idle'|'loading'|'ready'|'error'}
 */
export function getParcelState() { return _state; }

/**
 * Returns the loaded parcel features (empty array until first fetch completes).
 * @returns {GeoJSON.Feature[]}
 */
export function getParcelFeatures() { return _features; }

/**
 * Fetch parcel features for the given WGS-84 bounding box.
 * New features are merged into the in-memory store (deduped by PARCELID).
 * Returns the full accumulated feature array.
 *
 * @param {[number,number,number,number]} bbox  [minLng, minLat, maxLng, maxLat]
 * @returns {Promise<GeoJSON.Feature[]>}
 */
export async function fetchParcelsForBbox(bbox) {
  _state = 'loading';
  try {
    const bboxStr = bbox.map(v => v.toFixed(6)).join(',');
    const resp = await fetch(`/api/parcels?bbox=${encodeURIComponent(bboxStr)}`);
    if (!resp.ok) throw new Error(`/api/parcels returned HTTP ${resp.status}`);
    const geojson = await resp.json();
    if (geojson.error) throw new Error(geojson.error);
    let added = 0;
    for (const f of geojson.features ?? []) {
      const pid = f.properties?.PARCELID;
      if (pid && _seenIds.has(pid)) continue;
      if (pid) _seenIds.add(pid);
      _features.push(f);
      added++;
    }
    _state = 'ready';
    return _features;
  } catch (err) {
    if (_state === 'loading') _state = 'error';
    throw err;
  }
}

/**
 * Convenience wrapper: fetch parcels using a legacy no-bbox call (uses the
 * server default bbox). Kept for callers that don't yet pass a bbox.
 * @returns {Promise<GeoJSON.Feature[]>}
 */
export async function fetchParcels() {
  return fetchParcelsForBbox([-88.07, 44.47, -87.89, 44.57]);
}

// ── Spatial query ─────────────────────────────────────────────────────────────

/**
 * Haversine distance in km between two [lng, lat] points.
 * @param {[number,number]} a
 * @param {[number,number]} b
 * @returns {number}
 */
function _distKm(a, b) {
  const R  = 6371;
  const d1 = (b[1] - a[1]) * Math.PI / 180;
  const d2 = (b[0] - a[0]) * Math.PI / 180;
  const x  = Math.sin(d1 / 2) ** 2
            + Math.cos(a[1] * Math.PI / 180)
            * Math.cos(b[1] * Math.PI / 180)
            * Math.sin(d2 / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/**
 * Returns the centroid [lng, lat] of a parcel polygon feature.
 * Handles Polygon and MultiPolygon.
 * @param {GeoJSON.Feature} feature
 * @returns {[number,number]|null}
 */
export function parcelCentroid(feature) {
  const geom = feature.geometry;
  if (!geom)                   return null;
  if (geom.type === 'Point')   return geom.coordinates;
  const ring = geom.type === 'MultiPolygon'
    ? geom.coordinates[0]?.[0]
    : geom.coordinates?.[0];
  if (!ring?.length) return null;
  return [
    ring.reduce((s, c) => s + c[0], 0) / ring.length,
    ring.reduce((s, c) => s + c[1], 0) / ring.length,
  ];
}

/**
 * Returns all parcel features whose centroid lies within radiusM metres of coord,
 * sorted by area descending.
 *
 * @param {[number,number]}   coord      [lng, lat]
 * @param {number}            radiusM    search radius in metres
 * @param {GeoJSON.Feature[]} [features] optional override; defaults to loaded features
 * @returns {Array<{feature: GeoJSON.Feature, ownerClass: OwnerClass, distM: number, norm: object}>}
 */
export function queryParcelsNear(coord, radiusM, features = _features) {
  const radiusKm = radiusM / 1000;
  const results  = [];
  for (const f of features) {
    const c = parcelCentroid(f);
    if (!c) continue;
    const d = _distKm(coord, c);
    if (d > radiusKm) continue;
    results.push({
      feature:    f,
      ownerClass: classifyOwnership(f.properties ?? {}),
      distM:      Math.round(d * 1000),
      norm:       normaliseParcelProps(f.properties ?? {}),
    });
  }
  // Sort: public classes first (city, county, state), then institutional, then private;
  // within each class sort by area descending.
  const CLASS_ORDER = { city: 0, county: 1, state: 2, institutional: 3, private: 4 };
  results.sort((a, b) => {
    const co = (CLASS_ORDER[a.ownerClass] ?? 4) - (CLASS_ORDER[b.ownerClass] ?? 4);
    if (co !== 0) return co;
    return b.norm.acres - a.norm.acres;
  });
  return results;
}

/**
 * Summarises an array of query results into ownership counts by class.
 * @param {ReturnType<typeof queryParcelsNear>} parcels
 * @returns {Record<OwnerClass, number>}
 */
export function summariseOwnership(parcels) {
  const counts = { city: 0, county: 0, state: 0, institutional: 0, private: 0 };
  for (const p of parcels) counts[p.ownerClass] = (counts[p.ownerClass] ?? 0) + 1;
  return counts;
}
