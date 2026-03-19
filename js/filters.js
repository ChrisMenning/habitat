/**
 * filters.js — Sighting filter chips for the Sightings panel.
 *
 * Filter chips operate as post-fetch in-memory queries against the GeoJSON
 * features already loaded. Selecting a chip recomputes which features are
 * displayed on each layer without triggering new API calls.
 *
 * Available filters:
 *   native-only     — show only features with est_key 'native' or 'endemic'
 *   invasive-only   — show only features with est_key 'invasive' or 'introduced'
 *   recent-30       — show only observations from the last 30 days
 *   near-habitat    — show only sightings within NEAR_KM of a loaded habitat site
 */

import { esc } from './ui.js';

const NEAR_KM = 0.5;

/** @type {Set<string>} currently active filter ids */
const _active = new Set();

/** Raw feature store — keyed by layer id. Set once after each load. */
const _allFeatures = new Map();

/** Habitat site coordinates — refreshed when corridor/waystation data loads. */
let _habitatCoords = [];

/** Callback to push filtered features back to the map. */
let _onFilter = null;

/** Optional extra predicate (e.g. timeline date range). Applied in addition to chip filters. */
let _datePredicate = null;

// ── Geometry ──────────────────────────────────────────────────────────────────

function distKm(a, b) {
  const R  = 6371;
  const d1 = (b[1] - a[1]) * Math.PI / 180;
  const d2 = (b[0] - a[0]) * Math.PI / 180;
  const x  = Math.sin(d1 / 2) ** 2
            + Math.cos(a[1] * Math.PI / 180)
            * Math.cos(b[1] * Math.PI / 180)
            * Math.sin(d2 / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function nearHabitat(coord) {
  return _habitatCoords.some(h => distKm(coord, h) <= NEAR_KM);
}

// ── Filter predicates ─────────────────────────────────────────────────────────

/** Returns true if the feature passes all currently active filters. */
function passes(feature) {
  const p = feature.properties;

  for (const id of _active) {
    switch (id) {
      case 'native-only':
        if (p.est_key !== 'native' && p.est_key !== 'endemic') return false;
        break;
      case 'invasive-only':
        if (p.est_key !== 'invasive' && p.est_key !== 'introduced' && p.est_key !== 'naturalised') return false;
        break;
      case 'recent-30': {
        if (!p.date) return false;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        if (new Date(p.date) < cutoff) return false;
        break;
      }
      case 'near-habitat':
        if (!feature.geometry?.coordinates) return false;
        if (!nearHabitat(feature.geometry.coordinates)) return false;
        break;
    }
  }
  if (_datePredicate && !_datePredicate(p.date)) return false;
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the filter system.
 *
 * @param {function(layerId: string, features: GeoJSON.Feature[]): void} onFilter
 *   Called whenever active filters change, with the filtered feature list per layer.
 */
export function initFilters(onFilter) {
  _onFilter = onFilter;
}

/**
 * Set an extra date predicate (e.g. from the timeline scrubber).
 * Called with the feature's date string; return true to keep the feature.
 * Pass null to remove.
 *
 * @param {((dateStr: string|undefined) => boolean)|null} predicate
 */
export function setDatePredicate(predicate) {
  _datePredicate = predicate;
  applyFilters();
}

/**
 * Store the full (pre-filter) feature set for one sighting layer.
 * Call this after every load, before applyFilters().
 *
 * @param {string}             layerId
 * @param {GeoJSON.Feature[]}  features
 */
export function setBaseFeatures(layerId, features) {
  _allFeatures.set(layerId, features);
}

/**
 * Provide habitat site coordinates so the 'near-habitat' filter has reference points.
 *
 * @param {Array<[number,number]>} coords  — [lng, lat] pairs
 */
export function setHabitatCoords(coords) {
  _habitatCoords = coords;
}

/**
 * Apply all active filters across every tracked layer and push results to the map.
 */
export function applyFilters() {
  for (const [layerId, features] of _allFeatures) {
    // Skip iteration only when there is truly nothing to filter.
    // _datePredicate must also be absent, otherwise the timeline range is ignored.
    const filtered = (_active.size === 0 && !_datePredicate)
      ? features
      : features.filter(passes);
    _onFilter?.(layerId, filtered);
  }
}

/**
 * Builds filter chip HTML and appends it to the given container element.
 * Chips toggle filters on click and immediately re-apply.
 *
 * @param {HTMLElement} container
 */
export function buildFilterChips(container) {
  const chips = [
    { id: 'native-only',  label: 'Native only',        icon: '<i class="ph ph-leaf"></i>' },
    { id: 'invasive-only', label: 'Invasive / introduced', icon: '<i class="ph ph-warning-octagon"></i>' },
    { id: 'recent-30',    label: 'Last 30 days',        icon: '<i class="ph ph-calendar"></i>' },
    { id: 'near-habitat', label: 'Near habitat sites',  icon: '<i class="ph ph-map-pin"></i>' },
  ];

  const row = document.createElement('div');
  row.className = 'filter-chips';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Sighting filters');

  for (const chip of chips) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip';
    btn.dataset.filterId = chip.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `${chip.icon} ${esc(chip.label)}`;

    btn.addEventListener('click', () => {
      const on = _active.has(chip.id);
      if (on) {
        _active.delete(chip.id);
        btn.classList.remove('filter-chip--active');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        _active.add(chip.id);
        btn.classList.add('filter-chip--active');
        btn.setAttribute('aria-pressed', 'true');
      }
      applyFilters();
    });

    row.appendChild(btn);
  }

  container.appendChild(row);
}
