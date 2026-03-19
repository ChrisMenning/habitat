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
 * Builds a GBIF occurrence search URL.
 *
 * GBIF range parameters (`decimalLatitude`, `decimalLongitude`, `eventDate`)
 * use a bare comma as the range separator — e.g. `decimalLatitude=44.1,44.9`.
 * `URLSearchParams` percent-encodes commas to `%2C`, which GBIF rejects with
 * 400 or silently ignores, returning wrong results. We therefore build the URL
 * manually, appending range values as literal strings after the encoded params.
 */
function buildGbifUrl(extraParams, offset, d1, d2) {
  const { minLat, maxLat, minLng, maxLng } = boundingBox();

  // Non-range params — safe to encode normally
  const encoded = new URLSearchParams({
    hasCoordinate:      'true',
    hasGeospatialIssue: 'false',
    occurrenceStatus:   'PRESENT',   // exclude absence records
    limit:              String(PER_PAGE),
    offset:             String(offset),
    ...extraParams,
  }).toString();

  // Range params — appended with literal commas
  let url = `${GBIF_API}?${encoded}`
    + `&decimalLatitude=${minLat.toFixed(4)},${maxLat.toFixed(4)}`
    + `&decimalLongitude=${minLng.toFixed(4)},${maxLng.toFixed(4)}`;

  if (d1 || d2) {
    const start = d1 ?? '1700-01-01';
    const end   = d2 ?? new Date().toISOString().slice(0, 10);
    url += `&eventDate=${start},${end}`;
  }

  return url;
}

/**
 * Fetches one GBIF page with automatic retry on 503 / 429 (rate-limit).
 * Waits 1 s before the first retry, 2 s before the second.
 */
async function fetchGbifPage(extraParams, offset, d1, d2) {
  const url = buildGbifUrl(extraParams, offset, d1, d2);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1200));
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (res.status !== 503 && res.status !== 429) {
      throw new Error(`GBIF API error: ${res.status} ${res.statusText}`);
    }
    // 503 / 429 — retry after back-off
  }
  throw new Error('GBIF API unavailable after retries (503/429)');
}

/**
 * Fetches all available occurrences for a single taxon query, up to GBIF_MAX_OBS,
 * using offset-based pagination.
 */
export async function fetchGbifAll(extraParams, d1, d2, onProgress) {
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

// ── GBIF backbone taxonomy keys ─────────────────────────────────────────────
//
// The GBIF occurrence search API requires NUMERIC backbone keys for taxon
// filtering (orderKey, familyKey, kingdomKey). The plain string parameters
// "order", "family", "kingdom" are NOT recognised by the API and are silently
// ignored, causing the query to return ALL occurrences in the bounding box.
//
// Keys are from the GBIF backbone taxonomy (https://www.gbif.org/dataset/d7dddbf4-...)
// and are stable long-term identifiers.
//
// Verify any key at: https://api.gbif.org/v1/species/<key>

/** Lepidoptera order (butterflies & moths) — nubKey 797 */
const KEY_LEPIDOPTERA  = 797;
/** Apidae (honey, bumble, carpenter, cuckoo bees) — nubKey 4334 */
const KEY_APIDAE       = 4334;
/** Halictidae (metallic-green, sweat bees) — nubKey 7908 */
const KEY_HALICTIDAE   = 7908;
/** Megachilidae (mason, leafcutter bees) — nubKey 7911 */
const KEY_MEGACHILIDAE = 7911;
/** Andrenidae (mining bees) — nubKey 7901 */
const KEY_ANDRENIDAE   = 7901;
/** Colletidae (plasterer, polyester bees) — nubKey 7905 */
const KEY_COLLETIDAE   = 7905;
/** Syrphidae (hoverflies/flower flies) — nubKey 6920 */
const KEY_SYRPHIDAE    = 6920;
/** Plantae kingdom — nubKey 6 */
const KEY_PLANTAE      = 6;
/** Animalia kingdom — nubKey 1 */
const KEY_ANIMALIA     = 1;

/**
 * Interpreted taxonomy families that constitute pollinators.
 * Used as a secondary client-side guard after the API call.
 * GBIF returns the interpreted `family` string on each occurrence.
 */
const POLLINATOR_FAMILIES = new Set([
  'Apidae', 'Halictidae', 'Megachilidae', 'Andrenidae', 'Colletidae', 'Syrphidae',
]);

/**
 * Returns true when a raw GBIF occurrence record represents a pollinator.
 * Matches Lepidoptera (order-level) plus the specific bee/hoverfly families.
 * Applied after the API call as a belt-and-suspenders guard.
 *
 * @param {object} o - raw GBIF occurrence
 * @returns {boolean}
 */
function isGbifPollinator(o) {
  return o.order === 'Lepidoptera' || POLLINATOR_FAMILIES.has(o.family);
}

// ── Data-quality filtering ───────────────────────────────────────────────────

/**
 * basisOfRecord values that represent non-wild or pre-modern occurrences.
 * These are excluded from all layers regardless of taxon.
 *
 * FOSSIL_SPECIMEN  — pre-modern; irrelevant for contemporary habitat analysis.
 * LIVING_SPECIMEN  — captive or cultivated individuals (zoos, botanical gardens);
 *                    these are NOT wild occurrences and distort range maps.
 */
const EXCLUDED_BASIS = new Set(['FOSSIL_SPECIMEN', 'LIVING_SPECIMEN']);

/**
 * GBIF data-quality issue flags that indicate the coordinate is spatially
 * unreliable.  Records carrying any of these are dropped.
 *
 * Intentionally excluded from this deny-list (minor precision issues only):
 *   COORDINATE_ROUNDED, GEODETIC_DATUM_ASSUMED_WGS84, TAXON_MATCH_HIGHERRANK
 */
const FATAL_COORD_ISSUES = new Set([
  'COORDINATE_INVALID',
  'ZERO_COORDINATE',
  'COORDINATE_OUT_OF_RANGE',
  'COUNTRY_COORDINATE_MISMATCH',
  'PRESUMED_SWAPPED_COORDINATE',
  'GEODETIC_DATUM_INVALID',
]);

/**
 * Maximum coordinate uncertainty radius (metres).  Within a 15 km study
 * circle a record with uncertainty > 10 km could fall anywhere in the area,
 * making it useless for local habitat correlation.
 */
const MAX_UNCERTAINTY_M = 10_000;

/**
 * Filters raw GBIF occurrences for data quality.
 *
 * Removes:
 *   • absence records (occurrenceStatus !== 'PRESENT')
 *   • fossil and captive/cultivated specimens
 *   • records with fatal coordinate quality flags
 *   • records with coordinate uncertainty > 10 km
 *   • (when requireSpecies=true) records not resolved to species rank,
 *     which typically means GBIF couldn't match the record to a named species
 *     and the taxon identity is uncertain — important for pollinators where
 *     a genus-only ID doesn't confirm which pollinator family the animal belongs to
 *
 * @param {object[]} occurrences
 * @param {{ requireSpecies?: boolean }} [opts]
 * @returns {object[]}
 */
export function filterOccurrences(occurrences, { requireSpecies = false } = {}) {
  return occurrences.filter(o => {
    // Presence check (API param should already handle this; belt-and-suspenders)
    if (o.occurrenceStatus && o.occurrenceStatus !== 'PRESENT') return false;

    // Fossil / captive specimens are not wild contemporary records
    if (EXCLUDED_BASIS.has(o.basisOfRecord)) return false;

    // Fatal spatial issues
    const issues = Array.isArray(o.issues) ? o.issues : [];
    if (issues.some(f => FATAL_COORD_ISSUES.has(f))) return false;

    // Excessive coordinate uncertainty makes local-scale placement meaningless
    if (o.coordinateUncertaintyInMeters != null &&
        o.coordinateUncertaintyInMeters > MAX_UNCERTAINTY_M) return false;

    // Species-level identification required for pollinators:
    // a record identified only to genus or family cannot confirm whether
    // this individual belongs to a pollinator species within that group.
    if (requireSpecies && !o.speciesKey && !o.species) return false;

    return true;
  });
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
  // Fire pollinator family/order requests sequentially in two small batches
  // to stay within GBIF's rate limit (~60 req/min). Two batches of 3 with a
  // short pause between is well within the limit while still being fast.
  // orderKey / familyKey are numeric GBIF backbone IDs — the only parameters
  // the GBIF occurrence search API actually recognises for taxon filtering.
  // Do NOT use plain "order" / "family" string params; those are silently ignored.
  const queries = [
    { orderKey:  KEY_LEPIDOPTERA  }, // butterflies + moths
    { familyKey: KEY_APIDAE       }, // honey/bumble/carpenter bees
    { familyKey: KEY_HALICTIDAE   }, // metallic green, sweat bees
    { familyKey: KEY_MEGACHILIDAE }, // mason, leafcutter bees
    { familyKey: KEY_ANDRENIDAE   }, // mining bees
    { familyKey: KEY_COLLETIDAE   }, // plasterer, polyester bees
    { familyKey: KEY_SYRPHIDAE    }, // hoverflies
  ];

  const seen = new Map();
  for (let i = 0; i < queries.length; i += 3) {
    if (i > 0) await new Promise(r => setTimeout(r, 400)); // brief pause between batches
    const batch = await Promise.allSettled(
      queries.slice(i, i + 3).map(q => fetchGbifPage(q, 0, d1, d2))
    );
    for (const page of batch) {
      if (page.status === 'fulfilled') {
        for (const o of page.value.results ?? []) {
          // Secondary taxonomy guard: verify the record's interpreted family/order
          // matches a pollinator group. Catches any stray records that slip through
          // if the backbone key lookup behaves unexpectedly.
          if (isGbifPollinator(o)) seen.set(o.key, o);
        }
      }
    }
  }

  // Apply data-quality filters.  requireSpecies ensures every returned record
  // has a resolved species identity — a genus-only Apidae record cannot
  // confirm which bee species was observed.
  const occurrences = filterOccurrences([...seen.values()], { requireSpecies: true });
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
  // kingdomKey: 6 = Plantae in the GBIF backbone taxonomy.
  // Using the numeric key is required; the string "kingdom=Plantae" is ignored.
  const raw = await fetchGbifAll({ kingdomKey: KEY_PLANTAE }, d1, d2, onProgress);
  // Apply quality filters.  requireSpecies is false for plants because many
  // herbarium specimens carry only genus-level determinations yet are still
  // valid for establishment-means analysis and historical range context.
  const occurrences = filterOccurrences(raw.occurrences, { requireSpecies: false });
  return { occurrences, total: raw.total };
}

/**
 * Fetches non-pollinator animal occurrences from GBIF.
 *
 * Queries all Animalia (kingdomKey: 1) within the study area, then filters out
 * pollinator taxa client-side so there is no double-counting with the
 * gbif-pollinators layer.  Includes birds, mammals, reptiles, amphibians,
 * fish, and non-pollinator invertebrates.
 *
 * @param {string|undefined}                   d1
 * @param {string|undefined}                   d2
 * @param {function(number, number): void}     [onProgress]
 * @returns {Promise<{occurrences: object[], total: number}>}
 */
export async function fetchGbifWildlife(d1, d2, onProgress) {
  // kingdomKey: 1 = Animalia in the GBIF backbone taxonomy.
  const raw = await fetchGbifAll({ kingdomKey: KEY_ANIMALIA }, d1, d2, onProgress);
  // Exclude pollinator taxa already covered by the pollinators layer.
  const nonPollinator = raw.occurrences.filter(o => !isGbifPollinator(o));
  const occurrences   = filterOccurrences(nonPollinator, { requireSpecies: true });
  return { occurrences, total: raw.total };
}

// ── Wisconsin establishment lookup via GBIF Species API ───────────────────────
//
// GBIF's occurrence search API does NOT populate `establishmentMeans` in its
// results — the field is never returned regardless of publisher. Instead, the
// GBIF Species API `/species/{key}/distributions` endpoint exposes WCVP-sourced
// regionalestablishment data keyed by TDWG location codes. Wisconsin = "TDWG:WIS".
//
// Strategy:
//   1. Collect unique speciesKeys from all plant occurrences.
//   2. Fetch distributions for each unique species in parallel batches.
//   3. For each species: if TDWG:WIS entry exists with INTRODUCED/NATURALISED/
//      INVASIVE/MANAGED/INVADED → non-native; otherwise → native (absent means
//      native or cosmopolitan, and native species dominate herbarium records).
//   4. Cache results so a reload doesn't re-fetch the same keys.

const GBIF_SPECIES_BASE = 'https://api.gbif.org/v1/species';

/** TDWG location code for Wisconsin (used by the WCVP checklist in GBIF). */
const WI_TDWG = 'TDWG:WIS';

/** Introduced/non-native establishment means values (uppercase Darwin Core). */
const NONNATIVE_EM = new Set(['INTRODUCED', 'NATURALISED', 'INVASIVE', 'MANAGED', 'INVADED']);

/**
 * In-memory cache: speciesKey (number) → 'native' | 'non-native'.
 * Persists for the lifetime of the page so reloads reuse results.
 */
const _estCache = new Map();

/**
 * Returns whether a single GBIF species is native ('native') or not ('non-native')
 * in Wisconsin, consulting the GBIF Species distributions endpoint.
 * Results are cached in _estCache.
 *
 * @param {number} speciesKey
 * @returns {Promise<'native'|'non-native'>}
 */
async function resolveEstablishment(speciesKey) {
  if (_estCache.has(speciesKey)) return _estCache.get(speciesKey);

  try {
    const res  = await fetch(`${GBIF_SPECIES_BASE}/${speciesKey}/distributions?limit=200`);
    if (!res.ok) { _estCache.set(speciesKey, 'native'); return 'native'; }
    const data = await res.json();

    const wiEntry = (data.results ?? []).find(d => d.locationId === WI_TDWG);
    const status  = (wiEntry && NONNATIVE_EM.has((wiEntry.establishmentMeans ?? '').toUpperCase()))
      ? 'non-native'
      : 'native';

    _estCache.set(speciesKey, status);
    return status;
  } catch {
    _estCache.set(speciesKey, 'native');
    return 'native';
  }
}

/**
 * Resolves establishment status for a batch of unique species keys in parallel,
 * with a concurrency limit to stay within GBIF's rate limit (60 req/min).
 *
 * @param {number[]} speciesKeys
 * @param {number}   [concurrency=10]
 * @returns {Promise<Map<number, 'native'|'non-native'>>}
 */
async function resolveEstablishmentBatch(speciesKeys, concurrency = 10) {
  const result = new Map();
  // Only look up keys not already cached
  const uncached = speciesKeys.filter(k => !_estCache.has(k));

  for (let i = 0; i < uncached.length; i += concurrency) {
    const chunk = uncached.slice(i, i + concurrency);
    const statuses = await Promise.all(chunk.map(k => resolveEstablishment(k)));
    chunk.forEach((k, j) => result.set(k, statuses[j]));
  }
  // Fill in cached values for the rest
  for (const k of speciesKeys) {
    if (!result.has(k)) result.set(k, _estCache.get(k) ?? 'native');
  }
  return result;
}

/**
 * Resolves establishment keys for a set of GBIF occurrences using the GBIF
 * Species distributions API. Returns a Map from GBIF occurrence key to the
 * est_key string used throughout this app ('native', 'introduced', etc.).
 *
 * Use this when you want per-record est_key data without partitioning into
 * separate buckets (e.g. for the pollinators layer where all records share
 * one layer_id but should show different ring colours).
 *
 * @param {object[]} occurrences - raw GBIF occurrence objects
 * @returns {Promise<Map<number, string>>}  occurrence.key → est_key
 */
export async function resolveOccurrenceEstKeys(occurrences) {
  const uniqueSpeciesKeys = [...new Set(
    occurrences.map(o => o.speciesKey ?? o.taxonKey).filter(Boolean)
  )];
  const statusMap = await resolveEstablishmentBatch(uniqueSpeciesKeys);

  const result = new Map();
  for (const o of occurrences) {
    const sk     = o.speciesKey ?? o.taxonKey;
    const status = sk ? (statusMap.get(sk) ?? 'native') : 'native';
    // Map the binary 'native'|'non-native' to a proper est_key
    result.set(o.key, status === 'non-native' ? 'introduced' : 'native');
  }
  return result;
}

/**
 * Splits raw GBIF plant occurrences into native and non-native buckets by
 * consulting the GBIF Species distributions API for each unique species.
 *
 * This is async because it may need to fetch distribution data from GBIF.
 * Results are cached so subsequent calls for the same species are instant.
 *
 * @param {object[]} occurrences - raw GBIF occurrence objects
 * @returns {Promise<{ native: object[], nonNative: object[] }>}
 */
export async function partitionPlantOccurrences(occurrences) {
  // Collect unique speciesKeys (fall back to taxonKey if speciesKey absent)
  const uniqueKeys = [...new Set(
    occurrences.map(o => o.speciesKey ?? o.taxonKey).filter(Boolean)
  )];

  const estMap = await resolveEstablishmentBatch(uniqueKeys);

  const native    = [];
  const nonNative = [];
  for (const o of occurrences) {
    const key    = o.speciesKey ?? o.taxonKey;
    const status = key ? (estMap.get(key) ?? 'native') : 'native';
    if (status === 'non-native') nonNative.push(o);
    else                         native.push(o);
  }
  return { native, nonNative };
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
 * @param {object[]}          occurrences  - raw GBIF occurrence objects
 * @param {string}             layerId      - e.g. 'gbif-pollinators' | 'gbif-native-plants' | 'gbif-non-native-plants'
 * @param {Map<number,string>} [estKeyMap]  - optional per-occurrence est_key override (from resolveOccurrenceEstKeys)
 * @returns {GeoJSON.FeatureCollection}
 */
export function gbifToGeoJSON(occurrences, layerId, estKeyMap = null) {
  // est_key resolution priority (highest to lowest):
  //   1. Per-occurrence estKeyMap (resolved via Species distributions API)
  //   2. Layer-level override for plant layers (all records in that bucket share a status)
  //   3. The occurrence's own establishmentMeans field (almost always empty in GBIF)
  const layerEstOverride =
    layerId === 'gbif-native-plants'     ? 'native'     :
    layerId === 'gbif-non-native-plants' ? 'introduced' :
    null;

  return {
    type: 'FeatureCollection',
    features: occurrences
      .filter(o => o.decimalLatitude != null && o.decimalLongitude != null)
      .map(o => {
        const estKey   = estKeyMap?.get(o.key) ?? layerEstOverride ?? gbifEstKey(o.establishmentMeans);
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
            id:        o.key,
            name:      taxonName,
            common:    o.vernacularName  ?? '',
            date:      o.eventDate?.slice(0, 10) ?? '',
            user:      o.recordedBy ?? o.institutionCode ?? '',
            image:     imageUrl,
            url:       `https://www.gbif.org/occurrence/${o.key}`,
            // Shared enum properties (used by MapLibre match expressions)
            layer_id:  layerId,
            est_key:   estKey,
            est_label: estLabel,
            // GBIF-specific — used by buildPopupHTML for source attribution
            source:    'gbif',
            dataset:   o.datasetName ?? o.institutionCode ?? 'GBIF',
          },
        };
      }),
  };
}
