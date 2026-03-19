/**
 * bees.js — North American Bee Distribution data layer.
 *
 * Mirrors the data source used by the FWS North American Bee Distribution Tool
 * (https://www.fws.gov/beetool), which draws GBIF occurrence records for the
 * six recognized bee families and overlays NatureServe conservation ranks.
 * All records are scoped to the Brown County / Green Bay study area via the
 * bounding-box query defined in config.js.
 *
 * Three layers are produced:
 *   bees-records   — all records for all 6 bee families (amber dots)
 *   bees-richness  — heatmap of occurrence density (species richness proxy)
 *   bees-imperiled — subset filtered to species with NatureServe G1–G3 or
 *                    IUCN VU/EN/CR ranks (red dots; each popup shows rank)
 *
 * No DOM. No map. All public functions are independently testable.
 * The only side-effect is fetch().
 */

import { fetchGbifAll, filterOccurrences } from './gbif.js';

// ── Bee family backbone keys ──────────────────────────────────────────────────
//
// Numeric GBIF backbone taxonomy keys — the ONLY form the GBIF occurrence
// search API accepts for family-level filtering. Plain string "family=Apidae"
// is silently ignored and returns all occurrences in the bbox.
//
// Verify any key at: https://api.gbif.org/v1/species/<key>

/** Andrenidae (mining bees)                    — nubKey 7901 */
const KEY_ANDRENIDAE   = 7901;
/** Apidae (honey, bumble, carpenter bees)      — nubKey 4334 */
const KEY_APIDAE       = 4334;
/** Colletidae (plasterer, polyester bees)      — nubKey 7905 */
const KEY_COLLETIDAE   = 7905;
/** Halictidae (sweat bees, metallic-green)     — nubKey 7908 */
const KEY_HALICTIDAE   = 7908;
/** Megachilidae (mason, leafcutter bees)       — nubKey 7911 */
const KEY_MEGACHILIDAE = 7911;
/** Melittidae (oil-collecting specialist bees) — nubKey 4345 */
const KEY_MELITTIDAE   = 4345;

/** familyKey → display label */
const BEE_FAMILY_NAMES = new Map([
  [KEY_ANDRENIDAE,   'Andrenidae'],
  [KEY_APIDAE,       'Apidae'],
  [KEY_COLLETIDAE,   'Colletidae'],
  [KEY_HALICTIDAE,   'Halictidae'],
  [KEY_MEGACHILIDAE, 'Megachilidae'],
  [KEY_MELITTIDAE,   'Melittidae'],
]);

// ── Conservation status database ─────────────────────────────────────────────
//
// Static lookup of North American bee species with documented conservation
// concern. Compiled from:
//   • NatureServe Explorer global ranks (G1–G3):
//       https://explorer.natureserve.org/
//   • IUCN Red List 2022 bumble bee assessments:
//       https://www.iucnredlist.org/
//   • USFWS Endangered Species Act listings (B. affinis, B. franklini):
//       https://www.fws.gov/species/
//   • USGS / FWS North American Bee Distribution Tool data notes:
//       https://www.fws.gov/beetool
//
// G-rank key:
//   G1 = Critically Imperiled   G2 = Imperiled   G3 = Vulnerable
//   G4 = Apparently Secure      G5 = Secure
//
// 'tier' drives the circle color on the bees-imperiled layer:
//   'cr' → red          (G1 / CR / ESA listed)
//   'en' → orange-red   (G2 / EN)
//   'vu' → amber        (G2G3–G3 / VU)
//   'nt' → yellow       (G4 / NT / regional concern)

const CONSERVATION_DB = new Map([
  // ── Federally listed / Critically Imperiled ──────────────────────────────
  ['Bombus affinis',       { gRank: 'G1',   iucn: 'CR', tier: 'cr', note: 'Rusty-patched Bumble Bee · ESA Endangered' }],
  ['Bombus franklini',     { gRank: 'G1',   iucn: 'CR', tier: 'cr', note: "Franklin's Bumble Bee · possibly extinct" }],
  ['Bombus variabilis',    { gRank: 'G1',   iucn: 'CR', tier: 'cr', note: 'Variable Cuckoo Bumble Bee' }],
  // ── Imperiled (G2 / EN) ──────────────────────────────────────────────────
  ['Bombus fraternus',     { gRank: 'G2',   iucn: 'EN', tier: 'en', note: 'Southern Plains Bumble Bee' }],
  ['Bombus auricomus',     { gRank: 'G2',   iucn: 'NT', tier: 'en', note: 'Black and Gold Bumble Bee' }],
  ['Bombus morrisoni',     { gRank: 'G2',   iucn: 'NT', tier: 'en', note: "Morrison's Bumble Bee" }],
  ['Bombus suckleyi',      { gRank: 'G2',   iucn: 'NT', tier: 'en', note: "Suckley's Cuckoo Bumble Bee" }],
  ['Andrena mandibularis', { gRank: 'G2',   iucn: 'DD', tier: 'en', note: 'Mining Bee (imperiled)' }],
  ['Andrena michenerorum', { gRank: 'G2',   iucn: 'DD', tier: 'en', note: "Michener's Mining Bee" }],
  // ── Vulnerable (G2G3–G3 / VU) ────────────────────────────────────────────
  ['Bombus pensylvanicus', { gRank: 'G2G3', iucn: 'VU', tier: 'vu', note: 'American Bumble Bee · sharply declining' }],
  ['Bombus occidentalis',  { gRank: 'G3',   iucn: 'VU', tier: 'vu', note: 'Western Bumble Bee' }],
  ['Bombus terricola',     { gRank: 'G4',   iucn: 'VU', tier: 'vu', note: 'Yellow-banded Bumble Bee' }],
  ['Bombus bohemicus',     { gRank: 'G2G3', iucn: 'DD', tier: 'vu', note: 'Ashton Cuckoo Bumble Bee' }],
  ['Colletes banksi',      { gRank: 'G3',   iucn: 'DD', tier: 'vu', note: "Banks' Plasterer Bee" }],
  ['Macropis ciliata',     { gRank: 'G3G4', iucn: 'DD', tier: 'vu', note: 'Oil-collecting Bee (specialist)' }],
  // ── Near Threatened / Regional concern ───────────────────────────────────
  ['Bombus bimaculatus',   { gRank: 'G4',   iucn: 'NT', tier: 'nt', note: 'Two-spotted Bumble Bee · regional decline' }],
  ['Xylocopa virginica',   { gRank: 'G5',   iucn: 'LC', tier: 'nt', note: 'Eastern Carpenter Bee · SU (unrankable) in WI' }],
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetches occurrence records for all six bee families from GBIF within the
 * current study bounding box.  Each family is queried independently
 * (supporting pagination via fetchGbifAll), then results are merged and
 * deduplicated by GBIF occurrence key.  Two batches of three families each
 * are dispatched with a brief pause between to stay within GBIF rate limits.
 *
 * Data-quality filtering (filterOccurrences) removes fossil/captive specimens,
 * records with fatal coordinate issues, and records with uncertainty > 10 km.
 * requireSpecies is intentionally false so genus-level museum specimens are
 * preserved — they still contribute meaningful bee presence signals.
 *
 * @param {string|undefined}               d1          — ISO date lower bound
 * @param {string|undefined}               d2          — ISO date upper bound
 * @param {function(number,number): void}  [onProgress]
 * @returns {Promise<{occurrences: object[], total: number}>}
 */
export async function fetchBeesAll(d1, d2, onProgress) {
  const familyKeys = [
    KEY_ANDRENIDAE,
    KEY_APIDAE,
    KEY_COLLETIDAE,
    KEY_HALICTIDAE,
    KEY_MEGACHILIDAE,
    KEY_MELITTIDAE,
  ];

  const seen = new Map();

  for (let i = 0; i < familyKeys.length; i += 3) {
    if (i > 0) await new Promise(r => setTimeout(r, 400));
    const batch = familyKeys.slice(i, i + 3);
    const results = await Promise.allSettled(
      batch.map(familyKey => fetchGbifAll({ familyKey }, d1, d2))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const familyKey = batch[j];
      for (const o of results[j].value.occurrences) {
        if (!seen.has(o.key)) {
          o._familyKey = familyKey; // stash for family-name lookup below
          seen.set(o.key, o);
        }
      }
    }
    onProgress?.(seen.size, seen.size);
  }

  const occurrences = filterOccurrences([...seen.values()], { requireSpecies: false });
  return { occurrences, total: occurrences.length };
}

/**
 * Converts raw GBIF bee occurrences into GeoJSON Features.
 *
 * Standard properties (name, common, date, user, image, url, layer_id,
 * est_key, source, dataset) mirror the schema used by gbifToGeoJSON so the
 * existing popup and filter systems work unchanged.
 *
 * Additional bee-specific properties:
 *   family        — bee family label (e.g. 'Apidae')
 *   g_rank        — NatureServe global rank if in CONSERVATION_DB, else ''
 *   iucn_cat      — IUCN Red List category if available, else ''
 *   conserv_note  — human-readable conservation note, else ''
 *   conserv_tier  — severity tier: 'cr' | 'en' | 'vu' | 'nt' | ''
 *
 * @param {object[]} occurrences
 * @param {string}   layerId   — 'bees-records' | 'bees-imperiled'
 * @returns {GeoJSON.FeatureCollection}
 */
export function beesToGeoJSON(occurrences, layerId) {
  return {
    type: 'FeatureCollection',
    features: occurrences
      .filter(o => o.decimalLatitude != null && o.decimalLongitude != null)
      .map(o => {
        const taxonName   = o.species ?? o.genus ?? o.family ?? 'Unknown bee';
        const conserv     = CONSERVATION_DB.get(o.species) ?? null;
        const familyLabel = o.family ?? (BEE_FAMILY_NAMES.get(o._familyKey) ?? 'Bee');
        const imageUrl    = o.media?.find(m => m.type === 'StillImage')?.identifier ?? '';
        return {
          type: 'Feature',
          geometry: {
            type:        'Point',
            coordinates: [o.decimalLongitude, o.decimalLatitude],
          },
          properties: {
            name:         taxonName,
            common:       o.vernacularName ?? '',
            date:         o.eventDate      ?? '',
            user:         o.recordedBy     ?? '',
            image:        imageUrl,
            url:          o.key ? `https://www.gbif.org/occurrence/${o.key}` : '',
            layer_id:     layerId,
            est_key:      'unknown',
            est_label:    '',
            source:       'gbif-bee',
            dataset:      o.institutionCode ?? o.datasetName ?? 'GBIF',
            // Bee-specific
            family:       familyLabel,
            g_rank:       conserv?.gRank      ?? '',
            iucn_cat:     conserv?.iucn        ?? '',
            conserv_note: conserv?.note        ?? '',
            conserv_tier: conserv?.tier        ?? '',
          },
        };
      }),
  };
}

/**
 * Returns the imperiled subset of features: only those where the species
 * appears in CONSERVATION_DB (G1–G4 or IUCN NT+).
 *
 * @param {GeoJSON.Feature[]} allFeatures — from beesToGeoJSON
 * @returns {GeoJSON.Feature[]}
 */
export function filterImperiledFeatures(allFeatures) {
  return allFeatures.filter(f => f.properties.conserv_tier !== '');
}

/**
 * Returns a species-richness summary for a set of raw bee occurrences.
 *
 * @param {object[]} occurrences
 * @returns {{ totalSpecies: number, byFamily: Record<string, number>, imperiled: number }}
 */
export function computeSpeciesRichness(occurrences) {
  const allSpecies = new Set();
  const byFamily   = {};
  let imperiled    = 0;

  for (const o of occurrences) {
    if (o.species) allSpecies.add(o.species);
    const f = o.family ?? 'Unknown';
    byFamily[f] = (byFamily[f] ?? 0) + 1;
    if (o.species && CONSERVATION_DB.has(o.species)) imperiled++;
  }

  return { totalSpecies: allSpecies.size, byFamily, imperiled };
}
