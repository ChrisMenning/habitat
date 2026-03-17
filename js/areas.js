/**
 * areas.js — Protected area polygons and pesticide hazard monitoring points.
 *
 * Data sources:
 *   PAD-US v3.0  — USGS Protected Areas Database (polygon)
 *     https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Public_Access/FeatureServer/0
 *   WI DNR SNA   — Wisconsin State Natural Areas (polygon)
 *     https://dnrmaps.wi.gov/arcgis/rest/services/ER_Biotics/ER_Biotics_WGS84_Managed_Lands/MapServer/1
 *   WI DNR Lands — WI DNR Managed Properties (polygon)
 *     https://dnrmaps.wi.gov/arcgis/rest/services/ER_Biotics/ER_Biotics_WGS84_Managed_Lands/MapServer/3
 *   WQP          — USGS Water Quality Portal pesticide monitoring stations (point)
 *     https://www.waterqualitydata.us/Station/search
 *
 * All polygon queries use the ArcGIS REST FeatureServer/MapServer query endpoint
 * with an envelope geometry filter and outSR=4326 so features arrive in WGS 84.
 * URLSearchParams handles percent-encoding of commas in the bbox string.
 */

import { CENTER, RADIUS_KM } from './config.js';

// ── Bounding box computation ───────────────────────────────────────────────────

const [LNG, LAT] = CENTER;
const DEG_PER_KM_LAT = 1 / 111.32;
const DEG_PER_KM_LNG = 1 / (111.32 * Math.cos(LAT * Math.PI / 180));

const BBOX = {
  minX: +(LNG - RADIUS_KM * DEG_PER_KM_LNG).toFixed(5),
  minY: +(LAT - RADIUS_KM * DEG_PER_KM_LAT).toFixed(5),
  maxX: +(LNG + RADIUS_KM * DEG_PER_KM_LNG).toFixed(5),
  maxY: +(LAT + RADIUS_KM * DEG_PER_KM_LAT).toFixed(5),
};

// ── ArcGIS REST helper ────────────────────────────────────────────────────────

/**
 * Queries an ArcGIS REST `/query` endpoint and returns a GeoJSON FeatureCollection.
 * Uses URLSearchParams so all values (including commas in the bbox) are correctly
 * percent-encoded.
 *
 * @param {string} baseUrl - full URL to the layer's /query endpoint
 * @param {Record<string,string>} extraParams - additional query parameters
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
async function arcgisQuery(baseUrl, extraParams) {
  const params = new URLSearchParams({
    where:            '1=1',
    geometry:         `${BBOX.minX},${BBOX.minY},${BBOX.maxX},${BBOX.maxY}`,
    geometryType:     'esriGeometryEnvelope',
    inSR:             '4326',
    spatialRel:       'esriSpatialRelIntersects',
    returnGeometry:   'true',
    outSR:            '4326',
    f:                'geojson',
    resultRecordCount: '1000',
    ...extraParams,
  });

  const res = await fetch(`${baseUrl}?${params.toString()}`);
  if (!res.ok) throw new Error(`ArcGIS query failed: ${res.status} ${baseUrl}`);
  const json = await res.json();
  if (json.error) throw new Error(`ArcGIS error ${json.error.code}: ${json.error.message}`);
  return json;
}

// ── PAD-US lookup tables (for human-readable popup labels) ────────────────────

const MANG_TYPE_LABEL = {
  FED: 'Federal',
  STAT: 'State',
  LOC: 'Local Gov.',
  TRIB: 'Tribal',
  NGO: 'Non-Profit',
  JNT: 'Joint',
  DIST: 'District',
  TERR: 'Territory',
};

const PUB_ACCESS_LABEL = {
  OA: 'Open',
  UNK: 'Unknown',
  RA: 'Restricted',
  XA: 'No access',
  UK: 'Unknown',
};

const GAP_STATUS_LABEL = {
  1: 'Strictly protected (GAP 1)',
  2: 'Protected w/ exceptions (GAP 2)',
  3: 'Managed with some use (GAP 3)',
  4: 'No formal protection (GAP 4)',
};

// ── PAD-US v3.0 ───────────────────────────────────────────────────────────────

const PADUS_QUERY_URL =
  'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Public_Access/FeatureServer/0/query';

/**
 * Fetches PAD-US v3.0 protected area polygons for the app's bounding box.
 * Returns a GeoJSON FeatureCollection with normalised properties.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchPadUs() {
  const raw = await arcgisQuery(PADUS_QUERY_URL, {
    outFields: 'Unit_Nm,Mang_Type,Mang_Name,Des_Tp,Pub_Access,GAP_Sts',
  });

  raw.features = raw.features.map(f => ({
    ...f,
    properties: {
      data_source:  'padus',
      name:         f.properties.Unit_Nm    || 'Protected Area',
      manager_type: MANG_TYPE_LABEL[f.properties.Mang_Type] || f.properties.Mang_Type || '',
      manager:      f.properties.Mang_Name  || '',
      designation:  f.properties.Des_Tp     || '',
      public_access: PUB_ACCESS_LABEL[f.properties.Pub_Access] ?? f.properties.Pub_Access ?? '',
      gap_status:   GAP_STATUS_LABEL[f.properties.GAP_Sts] ?? `GAP ${f.properties.GAP_Sts}`,
    },
  }));

  return raw;
}

// ── WI DNR State Natural Areas ────────────────────────────────────────────────

const DNR_BIOTICS_BASE =
  'https://dnrmaps.wi.gov/arcgis/rest/services/ER_Biotics/ER_Biotics_WGS84_Managed_Lands/MapServer';

/**
 * Fetches Wisconsin State Natural Areas (SNAs) for the app's bounding box.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchDnrSna() {
  const raw = await arcgisQuery(`${DNR_BIOTICS_BASE}/1/query`, {
    outFields: 'SNA_NAME,SNA_URL,SNA_ACRE_AMT',
  });

  raw.features = raw.features.map(f => ({
    ...f,
    properties: {
      data_source: 'dnr-sna',
      name:        f.properties.SNA_NAME     || 'State Natural Area',
      url:         f.properties.SNA_URL      || '',
      acres:       f.properties.SNA_ACRE_AMT  || 0,
    },
  }));

  return raw;
}

// ── WI DNR Managed Lands ──────────────────────────────────────────────────────

/**
 * Fetches WI DNR managed property polygons for the app's bounding box.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchDnrManagedLands() {
  const raw = await arcgisQuery(`${DNR_BIOTICS_BASE}/3/query`, {
    outFields: 'PROP_NAME',
  });

  raw.features = raw.features.map(f => ({
    ...f,
    properties: {
      data_source: 'dnr-managed',
      name:        f.properties.PROP_NAME || 'DNR Land',
    },
  }));

  return raw;
}

// ── WQP Pesticide Monitoring ──────────────────────────────────────────────────

const WQP_STATION_URL = 'https://www.waterqualitydata.us/Station/search';

/**
 * Fetches USGS Water Quality Portal monitoring stations that recorded
 * pesticide measurements within the app's bounding box.
 *
 * Returns a GeoJSON FeatureCollection with normalised properties that are
 * compatible with the standard circle-layer format (layer_id, est_key).
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchPesticideMonitoring() {
  const params = new URLSearchParams({
    bBox:               `${BBOX.minX},${BBOX.minY},${BBOX.maxX},${BBOX.maxY}`,
    characteristicGroup: 'Pesticides',
    mimeType:           'geojson',
  });

  const res = await fetch(`${WQP_STATION_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`WQP request failed: ${res.status}`);
  const raw = await res.json();

  // WQP returns a FeatureCollection of point stations.
  // We normalise properties to the circle-layer schema used by all iNat/GBIF layers.
  raw.features = (raw.features ?? []).map(f => ({
    ...f,
    properties: {
      layer_id:        'wqp-pesticide',
      est_key:         'unknown',
      data_source:     'wqp',
      // Display fields
      name:            f.properties.MonitoringLocationName         || 'Monitoring Station',
      common:          '',
      org:             f.properties.OrganizationFormalName         || '',
      site_type:       f.properties.MonitoringLocationTypeName     || '',
      activity_count:  f.properties.activityCount                  ?? 0,
      result_count:    f.properties.resultCount                    ?? 0,
      state:           f.properties.StateName                      || '',
      county:          f.properties.CountyName                     || '',
      url:             f.properties.siteUrl                        || '',
      // popup compat
      date:  '',
      user:  '',
      image: '',
    },
  }));

  return raw;
}
