/**
 * areas.js — Protected area polygons and pesticide hazard monitoring points.
 *
 * Data sources:
 *   PAD-US v3.0     — USGS Protected Areas Database (polygon)
 *     https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Public_Access/FeatureServer/0
 *   WI DNR SNA      — Wisconsin State Natural Areas (polygon)
 *     https://dnrmaps.wi.gov/arcgis/rest/services/ER_Biotics/ER_Biotics_WGS84_Managed_Lands/MapServer/1
 *   WI DNR Lands    — WI DNR Managed Properties (polygon)
 *     https://dnrmaps.wi.gov/arcgis/rest/services/ER_Biotics/ER_Biotics_WGS84_Managed_Lands/MapServer/3
 *   WI DNR PFAS     — PFAS chemical contamination sites in surface water & fish (point)
 *     https://dnrmaps.wi.gov/arcgis/rest/services/WT_SWDV/WY_PFAS_SITES_AND_DATA/MapServer/0
 *   GBCC Corridor   — NE Wisconsin Pollinator Corridor planting areas (polygon)
 *     https://services1.arcgis.com/rR5gshOOu0KM2c4P/arcgis/rest/services/PollinatorCorridor_gdb/FeatureServer/1
 *   GBCC Treatments — Green Bay Conservation Corps habitat restoration treatments (polygon)
 *     https://services1.arcgis.com/rR5gshOOu0KM2c4P/arcgis/rest/services/Treatment_Public/FeatureServer/0
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

// ── GBCC: NE Wisconsin Pollinator Corridor ───────────────────────────────────

const GBCC_BASE = 'https://services1.arcgis.com/rR5gshOOu0KM2c4P/arcgis/rest/services';

/**
 * Fetches NE Wisconsin Pollinator Corridor planting area polygons from the
 * Green Bay Conservation Corps (GBCC) ArcGIS feature service.
 *
 * These are the mapped habitat parcels that form the pollinator corridor
 * across Green Bay identified in the NE Wisconsin Pollinator Corridor Project
 * (https://storymaps.arcgis.com/stories/9f4ca337f8ed486ab8422be9ef8015a3).
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchPollinatorCorridor() {
  const raw = await arcgisQuery(`${GBCC_BASE}/PollinatorCorridor_gdb/FeatureServer/1/query`, {
    outFields: 'Park,Area,PlantList',
  });

  raw.features = raw.features.map(f => ({
    ...f,
    properties: {
      data_source: 'gbcc-corridor',
      name:        f.properties.Park      || 'Corridor Planting',
      area_sqft:   f.properties.Area      || 0,
      plant_list:  f.properties.PlantList || '',
    },
  }));

  return raw;
}

/**
 * Computes a Point FeatureCollection from corridor polygon features, placing a
 * centroid marker at the visual centre of each planting area polygon.
 * Markers carry the same properties as the source polygon so popups work.
 *
 * @param {GeoJSON.FeatureCollection} geojson - polygon FeatureCollection from fetchPollinatorCorridor
 * @returns {GeoJSON.FeatureCollection}
 */
export function corridorCentroids(geojson) {
  const features = geojson.features.map(f => {
    // Support both Polygon and MultiPolygon — use first outer ring either way
    const ring = f.geometry.type === 'MultiPolygon'
      ? f.geometry.coordinates[0][0]
      : f.geometry.coordinates[0];
    const pts = ring.slice(0, -1); // drop closing vertex (same as first)
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return {
      type:       'Feature',
      geometry:   { type: 'Point', coordinates: [lng, lat] },
      properties: { ...f.properties },
    };
  });
  return { type: 'FeatureCollection', features };
}

/**
 * Fetches GBCC habitat restoration treatment polygons for the app's bounding box.
 * The public feature service currently contains cut-stump and foliar treatment records.
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchCorridorTreatments() {
  const raw = await arcgisQuery(`${GBCC_BASE}/Treatment_Public/FeatureServer/0/query`, {
    outFields: 'Type_of_Treatment,Treatment_Date_and_Time,AcresMapped',
  });

  raw.features = raw.features.map(f => ({
    ...f,
    properties: {
      data_source:    'gbcc-treatment',
      name:           f.properties.Type_of_Treatment || 'Habitat Treatment',
      treatment_type: f.properties.Type_of_Treatment || '',
      // epoch ms → readable date string
      date:           f.properties.Treatment_Date_and_Time
                        ? new Date(f.properties.Treatment_Date_and_Time).toLocaleDateString()
                        : '',
      acres:          f.properties.AcresMapped
                        ? +f.properties.AcresMapped.toFixed(2)
                        : 0,
    },
  }));

  return raw;
}

// ── WI DNR PFAS Chemical Contamination Sites ─────────────────────────────────

const DNR_PFAS_URL =
  'https://dnrmaps.wi.gov/arcgis/rest/services/WT_SWDV/WY_PFAS_SITES_AND_DATA/MapServer/0/query';

/**
 * Fetches Wisconsin DNR PFAS (per- and polyfluoroalkyl substances) sample
 * sites — surface water and fish tissue — within the app's bounding box.
 *
 * PFAS are persistent synthetic chemicals found in waterways near Green Bay
 * that bioaccumulate up the food chain and are hazardous to pollinators,
 * birds, and other wildlife.
 *
 * Returns a GeoJSON FeatureCollection compatible with the standard
 * circle-layer format (layer_id, est_key).
 *
 * @returns {Promise<GeoJSON.FeatureCollection>}
 */
export async function fetchChemicalHazards() {
  const raw = await arcgisQuery(DNR_PFAS_URL, {
    outFields: 'PRIMARY_STATION_NAME,DATE_YEAR,SURFACE_WATER_FLAG,PFOS_MEASURE,PFOA_MEASURE,PDF_PRIMARY_LINK',
  });

  raw.features = (raw.features ?? []).map(f => ({
    ...f,
    properties: {
      layer_id:     'dnr-pfas',
      est_key:      'unknown',
      data_source:  'dnr-pfas',
      name:         f.properties.PRIMARY_STATION_NAME || 'PFAS Site',
      common:       '',
      year:         f.properties.DATE_YEAR            || '',
      surface_water: f.properties.SURFACE_WATER_FLAG === 'Y',
      fish_tissue:  f.properties.FISH_FLAG            === 'Y',
      pfos:         f.properties.PFOS_MEASURE         || '',
      pfoa:         f.properties.PFOA_MEASURE         || '',
      url:          f.properties.PDF_PRIMARY_LINK     || '',
      // popup compat
      date:  '',
      user:  '',
      image: '',
    },
  }));

  return raw;
}

