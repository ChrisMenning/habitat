/**
 * classify.js — Pure functions for classifying iNaturalist observations.
 *
 * No DOM, no map, no side-effects. All functions are independently testable.
 */

import { ESTABLISHMENT } from './config.js';

// ── Establishment means ──────────────────────────────────────────────────────

/**
 * Resolves the establishment means key for an observation.
 *
 * iNaturalist returns `taxon.establishment_means` only when `place_id` is
 * included in the API request. The field may be a plain string OR an object
 * with an `establishment_means` string property depending on API version.
 *
 * @param {object} obs - iNaturalist observation object
 * @returns {keyof typeof ESTABLISHMENT}
 */
export function getEstKey(obs) {
  const taxon = obs.taxon;
  if (!taxon) return 'unknown';

  const em = taxon.establishment_means;

  // The v1 API returns establishment_means as either a plain string or a
  // nested object: { establishment_means: "native", place: { ... } }
  const raw = em
    ? (typeof em === 'string' ? em : (em.establishment_means ?? '')).toLowerCase().trim()
    : '';

  // Normalise American English spelling returned by some API responses
  const key = raw === 'naturalized' ? 'naturalised' : raw;

  if (Object.prototype.hasOwnProperty.call(ESTABLISHMENT, key) && key !== '') {
    return key;
  }

  // Fallback: the v1 API also exposes top-level booleans computed from place
  // context. Use them when the establishment_means string is absent.
  if (taxon.endemic)   return 'endemic';
  if (taxon.native)    return 'native';
  if (taxon.introduced) return 'introduced';

  return 'unknown';
}

// ── Pollinator detection ─────────────────────────────────────────────────────

/**
 * Pattern matched against `preferred_common_name` (case-insensitive) for
 * Insecta. Add alternatives here to capture more pollinator groups.
 */
const INSECT_POLLINATOR_RE = /\bbee(s)?\b|bumblebee|bumble\s+bee|honey\s+bee|mason\s+bee|sweat\s+bee|leafcutter|miner\s+bee|butterfly|butterflies|\bskipper(s)?\b|\bmoth(s)?\b|hoverfly|hover[\s-]fl(y|ies)|flower\s+fl(y|ies)/i;

/**
 * Returns true when an observation belongs to a pollinator species.
 *
 * Covers: bees, butterflies, skippers, moths, hoverflies/flower-flies,
 * and hummingbirds (Aves).
 *
 * @param {object} obs - iNaturalist observation object
 * @returns {boolean}
 */
export function isPollinator(obs) {
  const taxon = obs.taxon;
  if (!taxon) return false;

  const iconic = taxon.iconic_taxon_name;
  const cn     = taxon.preferred_common_name ?? '';

  if (iconic === 'Aves')    return /hummingbird/i.test(cn);
  if (iconic === 'Insecta') return INSECT_POLLINATOR_RE.test(cn);

  return false;
}

// ── Layer classification ─────────────────────────────────────────────────────

/**
 * Assigns an observation to exactly one logical layer.
 *
 * Priority order:
 *   1. Pollinators (insects + hummingbirds matching criteria above)
 *   2. Native / endemic plants
 *   3. Other plants (introduced, invasive, unconfirmed)
 *   4. Everything else (wildlife fallback)
 *
 * @param {object} obs - iNaturalist observation object
 * @returns {'pollinators' | 'native-plants' | 'other-plants' | 'other-wildlife'}
 */
export function classifyObs(obs) {
  if (isPollinator(obs)) return 'pollinators';

  const iconic  = obs.taxon?.iconic_taxon_name;
  const estKey  = getEstKey(obs);

  if (iconic === 'Plantae') {
    return (estKey === 'native' || estKey === 'endemic')
      ? 'native-plants'
      : 'other-plants';
  }

  return 'other-wildlife';
}
