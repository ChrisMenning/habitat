/**
 * gbif.js — GBIF (Global Biodiversity Information Facility) API access.
 *
 * GBIF aggregates occurrence records from natural history museums, herbaria,
 * research surveys, and citizen-science platforms (including iNaturalist).
 * It provides historical depth—museum specimens going back decades—and
 * formally curated establishment-means data that complements iNat's
 * real-time citizen science.
 *
 * No DOM. No map. All functions are independently testable.
 * The only side-effect is `fetch()`.
 */

import { CENTER, RADIUS_KM, GBIF_MAX_OBS, ESTABLISHMENT } from './config.js';

const GBIF_API  = 'https://api.gbif.org/v1/occurrence/search';
const PER_PAGE  = 300; // GBIF maximum records per page

// ── Geographic helpers ────────────────────────────────────────────────────────

/**
 * Computes a tight rectangular bounding box (in decimal degrees) around CENTER
 * that contains the full RADIUS_KM search circle.
 *
 * @returns {{minLat: number, maxLat: number, minLng: number, maxLng: number}}
 */
function boundingBox() {
  const [centerLng, centerLat] = CENTER;
  const latDelta = RADIUS_KM / 111.0;
  const lngDelta = RADIUS_KM / (111.0 * Math.cos(centerLat * Math.PI / 180));
  return {
    minLat: centerLat - latDelta,
    maxLat: centerLat + latDelta,
    minLng: centerLng - lngDelta,
    maxLng: centerLng + lngDelta,
  };
}

// ── Low-level fetch ───────────────────────────────────────────────────────────

/**
 * Fetches one page of GBIF occurrences with the given taxon + date filters.
 *
 * @param {Record<string, string>} extraParams - taxon filter params (e.g. { order: 'Lepidoptera' })
 * @param {number}                 offset      - pagination offset (0-based)
 * @param {string|undefined}       d1          - start date (YYYY-MM-DD)
 * @param {string|undefined}       d2          - end date (YYYY-MM-DD)
 */
async function fetchGbifPage(extraParams, offset, d1, d2) {
  const { minLat, maxLat, minLng, maxLng } = boundingBox();

  const params = new URLSearchParams({
    decimalLatitude:    `${minLat.toFixed(4)},${maxLat.toFixed(4)}`,
    decimalLongitude:   `${minLng.toFixed(4)},${maxLng.toFixed(4)}`,
    hasCoordinate:      'true',
    hasGeospatialIssue: 'false',
    limit:              String(PER_PAGE),
    offset:             String(offset),
    ...extraParams,
  });

  if (d1 || d2) {
    // GBIF range syntax: "startDate,endDate"
    const start = d1 ?? '1700-01-01';
    const end   = d2 ?? new Date().toISOString().slice(0, 10);
    params.set('eventDate', `${start},${end}`);
  }

  const res = await fetch(`${GBIF_API}?${params}`);
  if (!res.ok) throw new Error(`GBIF API error: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Fetches all available occurrences for a single taxon query, up to GBIF_MAX_OBS,
 * using offset-based pagination.
 */
async function fetchGbifAll(extraParams, d1, d2, onProgress) {
  const results = [];
  let offset = 0;
  let total  = 0;

  while (results.length < GBIF_MAX_OBS) {
    const data  = await fetchGbifPage(extraParams, offset, d1, d2);
    total       = data.count ?? total;
    const batch = data.results ?? [];
    if (!batch.length) break;

    results.push(...batch);
    onProgress?.(results.length, total);

    if (data.endOfRecords || results.length >= GBIF_MAX_OBS) break;
    offset += PER_PAGE;
  }

  return { occurrences: results.slice(0, GBIF_MAX_OBS), total };
}

// ── Public data-fetching API ──────────────────────────────────────────────────

/**
 * Fetches pollinator occurrences from GBIF: Lepidoptera (butterflies & moths),
 * key bee families (Apidae, Halictidae, Megachilidae, Andrenidae), and
 * hoverflies (Syrphidae). All taxon groups are queried in parallel, then
 * merged and deduplicated by GBIF occurrence key.
 *
 * Each group is capped at one page (300 records). A 15 km radius around any
 * single city rarely holds more than 100–200 pinned/observed records per family,
 * so one page is sufficient in almost all cases.
 *
 * @param {string|undefined}                   d1
 * @param {string|undefined}                   d2
 * @param {function(number, number): void}     [onProgress]
 * @returns {Promise<{occurrences: object[], total: number}>}
 */
export async function fetchGbifPollinators(d1, d2, onProgress) {
  const pages = await Promise.allSettled([
    fetchGbifPage({ order:  'Lepidoptera'  }, 0, d1, d2), // butterflies + moths
    fetchGbifPage({ family: 'Apidae'       }, 0, d1, d2), // honey/bumble/carpenter bees
    fetchGbifPage({ family: 'Halictidae'   }, 0, d1, d2), // metallic green, sweat bees
    fetchGbifPage({ family: 'Megachilidae' }, 0, d1, d2), // mason, leafcutter bees
    fetchGbifPage({ family: 'Andrenidae'   }, 0, d1, d2), // mining bees
    fetchGbifPage({ family: 'Syrphidae'    }, 0, d1, d2), // hoverflies
  ]);

  // Merge and deduplicate by GBIF occurrence key
  const seen = new Map();
  for (const page of pages) {
    if (page.status === 'fulfilled') {
      for (const o of page.value.results ?? []) {
        seen.set(o.key, o);
      }
    }
  }

  const occurrences = [...seen.values()];
  onProgress?.(occurrences.length, occurrences.length);
  return { occurrences, total: occurrences.length };
}

/**
 * Fetches plant occurrence records from GBIF. Returns all Plantae within the
 * search area; GBIF-provided `establishmentMeans` is used for ring-color
 * classification where available (museum/herbarium records often have it).
 *
 * @param {string|undefined}                   d1
 * @param {string|undefined}                   d2
 * @param {function(number, number): void}     [onProgress]
 * @returns {Promise<{occurrences: object[], total: number}>}
 */
export async function fetchGbifPlants(d1, d2, onProgress) {
  return fetchGbifAll({ kingdom: 'Plantae' }, d1, d2, onProgress);
}

// ── GeoJSON conversion ────────────────────────────────────────────────────────

/**
 * Maps a GBIF `establishmentMeans` value (uppercase Darwin Core term)
 * to the lowercase key used in ESTABLISHMENT config.
 *
 * @param {string|undefined} em
 * @returns {string}
 */
function gbifEstKey(em) {
  const MAP = {
    NATIVE:      'native',
    ENDEMIC:     'endemic',
    INTRODUCED:  'introduced',
    NATURALISED: 'naturalised',
    INVASIVE:    'invasive',
    MANAGED:     'introduced', // closest semantic equivalent
    INVADED:     'invasive',
  };
  return MAP[(em ?? '').toUpperCase()] ?? 'unknown';
}

/**
 * Converts an array of GBIF occurrence records to a GeoJSON FeatureCollection.
 *
 * Property names deliberately mirror those produced by api.js
 * (observationsToGeoJSON) so that map.js, ui.js, and classify.js can treat
 * features from both sources uniformly. GBIF-specific fields (`source`,
 * `dataset`) are added for popup attribution.
 *
 * @param {object[]} occurrences  - raw GBIF occurrence objects
 * @param {string}   layerId      - 'gbif-pollinators' | 'gbif-plants'
 * @returns {GeoJSON.FeatureCollection}
 */
export function gbifToGeoJSON(occurrences, layerId) {
  return {
    type: 'FeatureCollection',
    features: occurrences
      .filter(o => o.decimalLatitude != null && o.decimalLongitude != null)
      .map(o => {
        const estKey   = gbifEstKey(o.establishmentMeans);
        const estLabel = (ESTABLISHMENT[estKey] ?? ESTABLISHMENT.unknown).label;
        // Use the most specific name available
        const taxonName = o.species ?? o.genus ?? o.family ?? 'Unknown';
        // First StillImage in the media array, if any
        const imageUrl  = o.media?.find(m => m.type === 'StillImage')?.identifier ?? '';

        return {
          type: 'Feature',
          geometry: {
            type:        'Point',
            coordinates: [o.decimalLongitude, o.decimalLatitude],
          },
          properties: {
            id:       o.key,
            name:     taxonName,
            common:   o.vernacularName  ?? '',
            date:     o.eventDate?.slice(0, 10) ?? '',
            user:     o.recordedBy ?? o.institutionCode ?? '',
            image:    imageUrl,
            url:      `https://www.gbif.org/occurrence/${o.key}`,
            // Shared enum properties (used by MapLibre match expressions)
            layer_id: layerId,
            est_key:  estKey,
            est_label: estLabel,
            // GBIF-specific — used by buildPopupHTML for source attribution
            source:   'gbif',
            dataset:  o.datasetName ?? o.institutionCode ?? 'GBIF',
          },
        };
      }),
  };
}
