/**
 * drawer.js — Site detail drawer.
 *
 * When the user clicks a habitat program site (corridor or waystation) the
 * standard MapLibre popup is suppressed in favour of a persistent slide-in
 * drawer on the right side of the screen. The drawer shows a dossier view:
 *   - Site name, type, and source
 *   - All available metadata fields
 *   - Live count of pollinator sightings within NEARBY_KM
 *   - List of other habitat sites within NEARBY_KM
 *   - External links
 *
 * Point features (observations) continue to use the regular popup.
 */

import { esc, openLightbox } from './ui.js';
import { computeMonthHistogram } from './alerts.js';
import { nestingTier, nestingDescription } from './nesting.js';
import { queryParcelsNear, OWNERSHIP_META, getParcelState } from './parcels.js';

const NEARBY_KM = 0.75;

/** All loaded pollinator sighting features — updated after each load. */
let _sightings = [];

/** All loaded habitat site features — updated after each load. */
let _habitatSites = [];

/** Nesting scores keyed by site name — updated asynchronously after NLCD fetch. */
let _nestingScores = new Map();

/** Tree canopy coverage percentages keyed by site name — updated asynchronously. */
let _canopyScores = new Map();

/** Urban InVEST crosswalk scores — array of {name, investScore} — populated when urban layer first loads. */
let _investCrosswalk = [];

/** Parcel features — updated when parcel layer is first enabled. */
let _parcelFeatures = [];

/** Wikimedia Commons images — updated asynchronously for the full app area. */
let _commonsImages = [];

export function setNestingScores(scores)    { _nestingScores  = scores   ?? new Map(); }
export function setCanopyScores(scores)     { _canopyScores   = scores   ?? new Map(); }
export function setInvestCrosswalkScores(data) { _investCrosswalk = data ?? []; }

// ── Score help popup events ───────────────────────────────────────────────────
// Wired once (guarded by flag) to the drawer body element; handles all
// .score-help-btn clicks via delegation so they survive innerHTML replacement.

let _shpEventsWired = false;

function _wireScoreHelpEvents(drawerBody) {
  if (_shpEventsWired) return;
  _shpEventsWired = true;

  drawerBody.addEventListener('click', e => {
    const btn = e.target.closest('.score-help-btn');
    if (btn) {
      e.stopPropagation();
      const targetId = btn.dataset.helpTarget;
      const popup    = targetId ? document.getElementById(targetId) : null;
      if (!popup) return;
      const wasOpen = !popup.hidden;
      // Close all open popups first
      drawerBody.querySelectorAll('.score-help-popup').forEach(p => {
        p.hidden = true;
        p.parentElement?.querySelector('.score-help-btn')?.setAttribute('aria-expanded', 'false');
      });
      if (!wasOpen) {
        popup.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    // Click outside any popup — close all
    if (!e.target.closest('.score-help-wrap')) {
      drawerBody.querySelectorAll('.score-help-popup:not([hidden])').forEach(p => {
        p.hidden = true;
        p.parentElement?.querySelector('.score-help-btn')?.setAttribute('aria-expanded', 'false');
      });
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    drawerBody.querySelectorAll('.score-help-popup:not([hidden])').forEach(p => {
      p.hidden = true;
      p.parentElement?.querySelector('.score-help-btn')?.setAttribute('aria-expanded', 'false');
    });
  });
}
export function setParcelFeatures(features) { _parcelFeatures = features ?? []; }
export function setCommonsImages(images)    { _commonsImages  = images   ?? []; }

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

function featureCentroid(feature) {
  const geom = feature.geometry;
  if (!geom) return null;
  if (geom.type === 'Point') return geom.coordinates;
  const ring = geom.coordinates?.[0];
  if (!ring?.length) return null;
  return [
    ring.reduce((s, c) => s + c[0], 0) / ring.length,
    ring.reduce((s, c) => s + c[1], 0) / ring.length,
  ];
}

// ── Public API ────────────────────────────────────────────────────────────────

export function setSightings(features) { _sightings = features; }

export function setHabitatSites(features) { _habitatSites = features; }

// ── Seasonal histogram ────────────────────────────────────────────────────────

const MONTH_ABBR_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Renders a 12-bar SVG seasonal activity histogram.
 * Bars represent sighting counts per calendar month within NEARBY_KM of a site.
 * WCAG: role="img" with descriptive aria-label.
 *
 * @param {number[]} monthCounts - 12-element array (index 0 = January)
 * @returns {string} HTML string (SVG element)
 */
function buildHistogramSVG(monthCounts) {
  const W = 264, H = 60, padL = 4, padR = 4, padT = 4, padB = 18;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const maxCount = Math.max(...monthCounts, 1);
  const barW = plotW / 12;

  // Find peak and describe pattern for aria-label
  const peakMonth  = monthCounts.indexOf(Math.max(...monthCounts));
  const hasGap     = monthCounts.some(c => c === 0);
  const gapMonths  = monthCounts
    .map((c, i) => c === 0 ? MONTH_ABBR_SHORT[i] : null)
    .filter(Boolean);
  const peakLabel  = maxCount > 0 ? `peak in ${MONTH_ABBR_SHORT[peakMonth]}` : 'no sightings';
  const gapLabel   = gapMonths.length ? `, gap in ${gapMonths.join(', ')}` : '';
  const ariaLabel  = `Sighting activity by month: ${peakLabel}${gapLabel}.`;

  const bars = monthCounts.map((count, i) => {
    const barH  = maxCount > 0 ? (count / maxCount) * plotH : 0;
    const x     = padL + i * barW + 1;
    const y     = padT + plotH - barH;
    const color = count === 0 ? '#374151' : '#34d399';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}" rx="1" aria-hidden="true"/>`;
  }).join('');

  const labels = MONTH_ABBR_SHORT.map((label, i) => {
    const x = padL + i * barW + barW / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 2}" text-anchor="middle" fill="#6b7280" font-size="8" aria-hidden="true">${label[0]}</text>`;
  }).join('');

  return `<svg role="img" aria-label="${esc(ariaLabel)}" viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
  ${bars}
  ${labels}
</svg>`;
}

/**
 * Build a collapsible "Observed Species" section grouped by layer/data-source.
 * Groups with >5 species get their own inner <details> to avoid wall-of-text.
 *
 * @param {Map<string, Map<string, number>>} speciesByGroup - layerId → (taxon → count)
 * @returns {string} HTML string
 */
function _buildSpeciesSection(speciesByGroup) {
  if (speciesByGroup.size === 0) return '';

  const GROUP_LABELS = {
    'pollinators':           'Pollinators (iNat)',
    'native-plants':         'Native Plants (iNat)',
    'gbif-pollinators':      'Pollinators (GBIF)',
    'gbif-native-plants':    'Native Plants (GBIF)',
    'gbif-non-native-plants':'Non-native Plants (GBIF)',
  };

  const groupsHtml = [...speciesByGroup.entries()].map(([gid, taxonMap]) => {
    const label   = GROUP_LABELS[gid] ?? gid;
    const entries = [...taxonMap.entries()].sort((a, b) => b[1] - a[1]); // descending count
    const items   = entries.map(([name, count]) =>
      `<li class="drawer-species-item"><span class="drawer-species-name">${esc(name)}</span><span class="drawer-species-count">${count}</span></li>`
    ).join('');

    if (entries.length <= 5) {
      return `<div class="drawer-species-group">
        <div class="drawer-species-group-label">${esc(label)}</div>
        <ul class="drawer-species-list">${items}</ul>
      </div>`;
    }
    // More than 5 — show first 5, rest collapsed
    const shown   = entries.slice(0, 5);
    const rest    = entries.slice(5);
    const shownHtml = shown.map(([name, count]) =>
      `<li class="drawer-species-item"><span class="drawer-species-name">${esc(name)}</span><span class="drawer-species-count">${count}</span></li>`
    ).join('');
    const restHtml = rest.map(([name, count]) =>
      `<li class="drawer-species-item"><span class="drawer-species-name">${esc(name)}</span><span class="drawer-species-count">${count}</span></li>`
    ).join('');
    return `<div class="drawer-species-group">
      <div class="drawer-species-group-label">${esc(label)}</div>
      <ul class="drawer-species-list">${shownHtml}</ul>
      <details class="drawer-species-more">
        <summary>${rest.length} more…</summary>
        <ul class="drawer-species-list">${restHtml}</ul>
      </details>
    </div>`;
  }).join('');

  return `<details class="drawer-species-details" open>
    <summary class="drawer-section-label drawer-section-summary">Observed Species</summary>
    <div class="drawer-species-groups">${groupsHtml}</div>
  </details>`;
}

// ── Parcel + photo drawer sections ───────────────────────────────────────────

/**
 * Builds a collapsible "Nearby Parcels" table section.
 * Handles parcel fetch states: loading → spinner, error → message, ready → table.
 * @param {number[]|null} coord  [lng, lat]
 */
function _buildNearbyParcelsSection(coord) {
  if (!coord) return '';
  const RADIUS_M = 400;

  const state = getParcelState();

  // Loading state — parcel fetch is in progress
  if (state === 'loading') {
    return `
    <details class="drawer-parcels-details" open>
      <summary class="drawer-section-label drawer-section-summary">Nearby Parcels (${RADIUS_M}&thinsp;m)</summary>
      <p class="parcel-loading"><span class="parcel-spinner" aria-hidden="true"></span> Loading parcel data…</p>
    </details>`;
  }

  // Error state — endpoint unreachable or returned an error
  if (state === 'error') {
    return `
    <details class="drawer-parcels-details">
      <summary class="drawer-section-label drawer-section-summary">Nearby Parcels (${RADIUS_M}&thinsp;m)</summary>
      <p class="parcel-unavailable">Parcel data unavailable — county GIS endpoint could not be reached.</p>
    </details>`;
  }

  // Idle or ready but no features loaded yet (layer not yet enabled)
  if (!_parcelFeatures.length) return '';

  const nearby = queryParcelsNear(coord, RADIUS_M, _parcelFeatures).slice(0, 5);
  if (!nearby.length) return '';

  const rows = nearby.map(p => {
    const meta = OWNERSHIP_META[p.ownerClass];
    const badgeStyle = p.ownerClass !== 'private'
      ? `background:${esc(meta.color)};color:${esc(meta.textColor)};`
      : 'background:#374151;color:#9ca3af;';
    const classBadge = `<span class="parcel-owner-badge" style="${badgeStyle}">${esc(meta.label)}</span>`;
    const copyBtn = p.norm.address !== '—'
      ? `<button class="parcel-copy-btn" data-address="${esc(p.norm.address)}" type="button" aria-label="Copy address ${esc(p.norm.address)}">📋&thinsp;<span class="copy-confirm" aria-live="polite"></span></button>`
      : '';
    const acresLabel = p.norm.acres > 0 ? p.norm.acres.toFixed(2) + '&thinsp;ac' : '—';
    return `<tr>
      <td class="parcel-td-owner">${esc(p.norm.owner)}</td>
      <td class="parcel-td-class">${classBadge}</td>
      <td class="parcel-td-pid">${esc(p.norm.parcelId)}</td>
      <td class="parcel-td-addr">${esc(p.norm.address)}</td>
      <td class="parcel-td-acres">${acresLabel}</td>
      <td class="parcel-td-copy">${copyBtn}</td>
    </tr>`;
  }).join('');

  return `
    <details class="drawer-parcels-details">
      <summary class="drawer-section-label drawer-section-summary">Nearby Parcels (${RADIUS_M}&thinsp;m)</summary>
      <table class="parcel-table" aria-label="Nearby parcels within ${RADIUS_M} m">
        <thead>
          <tr>
            <th scope="col">Owner / Municipality</th>
            <th scope="col">Class</th>
            <th scope="col">Parcel ID</th>
            <th scope="col">Location</th>
            <th scope="col">Area</th>
            <th scope="col"><span aria-label="Copy address">📋</span></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="parcel-zoom-hint">Enable "Parcel Ownership" layer to see parcels on map (zoom ≥ 14)</p>
    </details>`;
}

/**
 * Builds a collapsible "Nearby Photos" grid using pre-loaded Commons images.
 * @param {number[]|null} coord  [lng, lat]
 */
function _buildNearbyPhotosSection(coord) {
  if (!coord || !_commonsImages.length) return '';
  const RADIUS_KM = 0.5;
  const photos = _commonsImages.filter(img => {
    if (!img.lat || !img.lng) return false;
    const R  = 6371;
    const d1 = (img.lat - coord[1]) * Math.PI / 180;
    const d2 = (img.lng - coord[0]) * Math.PI / 180;
    const x  = Math.sin(d1 / 2) ** 2
              + Math.cos(coord[1] * Math.PI / 180)
              * Math.cos(img.lat  * Math.PI / 180)
              * Math.sin(d2 / 2) ** 2;
    return (R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))) <= RADIUS_KM;
  }).slice(0, 6);
  if (!photos.length) return '';

  const items = photos.map(img =>
    `<li class="commons-photo-item" role="listitem">
      <button class="commons-photo-thumb-btn"
              data-page-id="${esc(String(img.pageId))}"
              type="button"
              aria-label="View photo: ${esc(img.title)}">
        <img class="commons-photo-thumb"
             src="${esc(img.thumburl)}"
             alt="${esc(img.description || img.title)}"
             loading="lazy"
             width="120" height="90">
      </button>
    </li>`
  ).join('');

  return `
    <details class="drawer-photos-details">
      <summary class="drawer-section-label drawer-section-summary">Nearby Photos · Wikimedia Commons</summary>
      <ul class="commons-photo-grid" role="list">${items}</ul>
      <p class="commons-photo-note">Photos from Wikimedia Commons contributors — click to view attribution.</p>
    </details>`;
}

/**
 * Open the drawer with the given feature's dossier.
 * @param {GeoJSON.Feature} feature
 */
export function openDrawer(feature, alertFeatures = []) {
  const drawer = document.getElementById('site-drawer');
  const body   = document.getElementById('site-drawer-body');
  if (!drawer || !body) return;

  // Wire score-help popup toggle events once
  _wireScoreHelpEvents(body);

  const p    = feature.properties;
  const coord = featureCentroid(feature);

  // Approximate waystations are placed at zip-code centroid, not true GPS.
  // Use a much wider radius for sighting data and skip precision-dependent sections.
  const isApprox       = Boolean(p.approximate);
  const SIGHTING_KM    = isApprox ? 5.0 : NEARBY_KM;
  const sightingLabel  = isApprox ? '5 km area (approximate location)' : `${NEARBY_KM * 1000 | 0} m`;

  // ── Nearby sightings + seasonal histogram ────────────────────────────────
  let nearbySightingsCount = 0;
  const nearbySightingsAll = [];
  if (coord) {
    for (const s of _sightings) {
      const sc = s.geometry?.coordinates;
      if (sc && distKm(coord, sc) <= SIGHTING_KM) {
        nearbySightingsCount++;
        nearbySightingsAll.push(s);
      }
    }
  }

  // Group species by layer_id for the collapsible species section
  const GROUP_LABELS = {
    'pollinators':           'Pollinators (iNat)',
    'native-plants':         'Native Plants (iNat)',
    'gbif-pollinators':      'Pollinators (GBIF)',
    'gbif-native-plants':    'Native Plants (GBIF)',
    'gbif-non-native-plants':'Non-native Plants (GBIF)',
  };
  const speciesByGroup = new Map(); // layerId → Map<taxonName, count>
  for (const s of nearbySightingsAll) {
    const gid  = s.properties?.layer_id ?? 'other';
    const name = s.properties?.common || s.properties?.name || 'Unknown';
    if (!speciesByGroup.has(gid)) speciesByGroup.set(gid, new Map());
    const m = speciesByGroup.get(gid);
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  const uniqueSpeciesCount = [...speciesByGroup.values()]
    .reduce((sum, m) => sum + m.size, 0);
  const monthCounts = coord ? computeMonthHistogram(coord, nearbySightingsAll, SIGHTING_KM) : new Array(12).fill(0);

  // ── Nearby habitat sites ──────────────────────────────────────────────────
  // Skipped for approximate waystations — the zip-code pin is not meaningful
  // at sub-kilometre resolution.
  const nearbySites = (!isApprox && coord)
    ? _habitatSites.filter(s => {
        const sc = featureCentroid(s);
        return sc && s !== feature && distKm(coord, sc) <= NEARBY_KM;
      })
    : [];

  // ── Corridor network connectivity (corridor nodes only) ──────────────────
  const corridorConnHtml = (() => {
    if (p.data_source !== 'gbcc-corridor' || !coord) return '';

    const STRONG_M = 300;   // ≤ 300 m  — all native bee species
    const MESH_M   = 700;   // ≤ 700 m  — bumble bees / large solitary bees
    const WEAK_M   = 2000;  // ≤ 2000 m — weak signal; only occasional long-distance

    const corridorNeighbors = _habitatSites
      .filter(s => s.properties?.data_source === 'gbcc-corridor' && s !== feature)
      .map(s => ({ site: s, distM: distKm(coord, featureCentroid(s)) * 1000 }))
      .sort((a, b) => a.distM - b.distM);

    const optimal = corridorNeighbors.filter(n => n.distM <= STRONG_M).length;
    const ok      = corridorNeighbors.filter(n => n.distM > STRONG_M && n.distM <= MESH_M).length;
    const nearest = corridorNeighbors[0]?.distM ?? Infinity;

    const weakSignalHtml = (nearest > MESH_M && nearest <= WEAK_M) ? `
      <div class="drawer-weak-signal">
        <span class="drawer-weak-signal-icon"><i class="ph ph-warning" aria-hidden="true"></i></span>
        <div>
          <strong>Weak connectivity signal</strong> — nearest corridor node is ${Math.round(nearest)} m away.
          <p class="drawer-weak-blurb">
            Native bee foraging ranges vary widely by species:
            <em>small sweat bees &amp; mason bees</em> typically forage ≤ 300 m;
            <em>bumble bees</em> can reach 700 m–1.5 km on longer flights but prefer shorter trips;
            <em>large carpenter bees</em> occasionally cross up to 2 km.
            At this distance, network connectivity depends almost entirely on bumble bee species
            — a stepping-stone site within 700 m would restore reliable connectivity for the full
            native bee community.
          </p>
        </div>
      </div>` : '';

    return `
      <div class="drawer-section-label">Corridor network connectivity</div>
      <div class="drawer-stat-row">
        <div class="drawer-stat">
          <span class="drawer-stat-value">${optimal}</span>
          <span class="drawer-stat-label">Optimal neighbors (≤ 300 m)</span>
        </div>
        <div class="drawer-stat">
          <span class="drawer-stat-value">${ok}</span>
          <span class="drawer-stat-label">OK neighbors (300–700 m)</span>
        </div>
      </div>
      ${weakSignalHtml}`;
  })();

  // ── Build header color based on source ────────────────────────────────────
  const src = p.data_source;
  const headerColor = src === 'gbcc-corridor'  ? '#d97706'
                    : src === 'waystation'      ? '#7c3aed'
                    : src === 'gbcc-treatment'  ? '#65a30d'
                    : '#14532d';

  const titleLabel = src === 'gbcc-corridor'  ? 'Pollinator Corridor Site'
                   : src === 'waystation'      ? `Monarch Waystation #${esc(p.ws_id ?? '')}`
                   : src === 'gbcc-treatment'  ? 'Habitat Treatment'
                   : src === 'padus'           ? 'Protected Area'
                   : src === 'dnr-sna'         ? 'State Natural Area'
                   : src === 'dnr-managed'     ? 'DNR Managed Land'
                   : src === 'dnr-pfas'        ? 'PFAS Contamination Site'
                   : 'Site';

  // ── Meta rows ─────────────────────────────────────────────────────────────
  const metaRows = [];
  const add = (k, v) => { if (v) metaRows.push([k, v]); };

  if (src === 'waystation') {
    add('Registered',    p.registered);
    add('Habitat size',  p.size);
    add('Setting',       p.type);
    add('Location note', p.location);
  } else if (src === 'gbcc-corridor') {
    add('Area', p.area_sqft ? `${(+p.area_sqft).toLocaleString()} sq ft` : null);
    add('Plant list', p.plant_list);
  } else if (src === 'padus') {
    add('Manager',     p.manager);
    add('Type',        p.manager_type);
    add('Designation', p.designation);
    add('Access',      p.public_access);
    add('Protection',  p.gap_status);
  } else if (src === 'dnr-sna') {
    add('Area', p.acres ? `${(+p.acres).toFixed(0)} acres` : null);
  } else if (src === 'dnr-pfas') {
    add('Year',           p.year);
    add('PFOS (ng/L)',    p.pfos);
    add('PFOA (ng/L)',    p.pfoa);
  }

  const metaHtml = metaRows.length
    ? `<dl class="drawer-meta">${metaRows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`
    : '';

  const approxHtml = p.approximate
    ? `<div class="popup-approx approx-banner" style="margin:0 0 8px;">
        <i class="ph ph-map-pin-simple-slash" aria-hidden="true"></i>
        <div>
          <strong>Approximate location</strong> — coordinates placed at zip code centroid, not exact site address.
          Site-specific metrics (nesting score, nearby parcels, adjacent habitat sites) are not shown.
          Sighting data covers a 5&thinsp;km radius around the approximate pin.
        </div>
      </div>`
    : '';

  const nearbySightingsHtml = `
    <div class="drawer-stat-row">
      <div class="drawer-stat">
        <span class="drawer-stat-value">${nearbySightingsCount.toLocaleString()}</span>
        <span class="drawer-stat-label">Pollinator sightings within ${sightingLabel}</span>
      </div>
      <div class="drawer-stat">
        <span class="drawer-stat-value">${uniqueSpeciesCount}</span>
        <span class="drawer-stat-label">Species observed</span>
      </div>
    </div>
    ${_buildSpeciesSection(speciesByGroup)}
    <div class="drawer-section-label">Seasonal activity (sightings by month)</div>
    <div class="drawer-histogram">${buildHistogramSVG(monthCounts)}</div>
  `;

  const nearbySitesHtml = nearbySites.length
    ? `<div class="drawer-section-label">Nearby habitat sites</div>
       <ul class="drawer-nearby-list">${nearbySites.slice(0, 5).map(s => {
         const sp = s.properties;
         const dist = (distKm(coord, featureCentroid(s)) * 1000 | 0);
         return `<li>${esc(sp.name || sp.registrant || 'Site')} <span class="drawer-dist">${dist} m</span></li>`;
       }).join('')}</ul>`
    : '';

  const linkHtml = (() => {
    if (src === 'waystation') return `<a class="drawer-link" href="https://www.monarchwatch.org/waystations/" target="_blank" rel="noopener">Monarch Watch Waystations ↗</a>`;
    if (src === 'gbcc-corridor') return `<a class="drawer-link" href="https://storymaps.arcgis.com/stories/9f4ca337f8ed486ab8422be9ef8015a3" target="_blank" rel="noopener">Corridor StoryMap ↗</a>`;
    if (src === 'dnr-sna' && p.url) return `<a class="drawer-link" href="${esc(p.url)}" target="_blank" rel="noopener">SNA details ↗</a>`;
    if (src === 'dnr-pfas' && p.url) return `<a class="drawer-link" href="${esc(p.url)}" target="_blank" rel="noopener">DNR report ↗</a>`;
    return '';
  })();

  // ── Nesting suitability score ─────────────────────────────────────────────
  // Suppressed for approximate waystations — NLCD lookup within 300 m of a
  // zip-code centroid is not representative of the actual site conditions.
  const nestingHtml = (() => {
    if (isApprox) return '';
    const key  = p.name || p.registrant || '';
    const info = _nestingScores.get(key);
    if (!info) return '';
    const { tier, label, color } = nestingTier(info.score);
    const desc  = nestingDescription(info.score, info.counts ?? {});
    const ariaL = `Nesting suitability: ${info.score} out of 100 — ${label}. ${desc}`;
    return `
      <div class="drawer-section-label">
        Nesting suitability (NLCD 300 m radius)
        <div class="score-help-wrap">
          <button class="score-help-btn" type="button"
                  aria-label="How is the nesting score calculated?"
                  aria-expanded="false"
                  data-help-target="shp-nesting">
            <i class="ph ph-question" aria-hidden="true"></i>
          </button>
          <div class="score-help-popup" id="shp-nesting" hidden>
            <strong>Nesting Suitability Score (0–100)</strong>
            <p>Counts pixels of three NLCD 2021 land cover classes within 300 m of the site centroid. Each class carries a weight based on its value as ground-nesting bee substrate.</p>
            <div class="shp-formula">score = min(100, (B×3 + S×2 + G×3) / (total×3) × 500)<br>B = Barren (class 31, weight 3)<br>S = Shrub/Scrub (class 52, weight 2)<br>G = Grassland/Herbaceous (class 71, weight 3)</div>
            <p>20% weighted coverage → 100 points. Tiers: 0–33 Low (gray), 34–66 Moderate (tan), 67–100 Good (dark brown). The Poor Nesting Habitat alert fires when score &lt; 25.</p>
            <p class="shp-source">Source: MRLC / USGS NLCD 2021 · Fetched via /api/nlcd-nesting at tile zoom 13 (≈14 m/px) · 24 h server cache</p>
          </div>
        </div>
      </div>
      <div class="drawer-nesting-row"
           role="img"
           aria-label="${esc(ariaL)}">
        <div class="drawer-nesting-score" style="background:${color};">${info.score}</div>
        <div class="drawer-nesting-detail">
          <span class="drawer-nesting-label" style="color:${color};">${esc(label)}</span>
          <span class="drawer-nesting-desc">${esc(desc)}</span>
        </div>
      </div>`;
  })();
  // ── Tree canopy coverage (WI DNR 2022 survey) ────────────────────────────────
  const canopyHtml = (() => {
    if (src !== 'gbcc-corridor') return '';
    const key = p.name || '';
    const pct = _canopyScores.get(key);
    if (typeof pct !== 'number') return '';
    const level   = pct > 55 ? 'high' : pct > 30 ? 'moderate' : 'low';
    const color   = pct > 55 ? '#3b6b3b' : pct > 30 ? '#6b8c3b' : '#9ca3af';
    const levelLbl = pct > 55 ? 'High — may suppress open-meadow plants'
                   : pct > 30 ? 'Moderate' : 'Low';
    return `
      <div class="drawer-section-label">
        Tree canopy (WI DNR UTC 2022, 150 m radius)
        <div class="score-help-wrap">
          <button class="score-help-btn" type="button"
                  aria-label="How is tree canopy coverage calculated?"
                  aria-expanded="false"
                  data-help-target="shp-canopy">
            <i class="ph ph-question" aria-hidden="true"></i>
          </button>
          <div class="score-help-popup" id="shp-canopy" hidden>
            <strong>Tree Canopy Coverage (%)</strong>
            <p>Counts tree-classified pixels within ~150 m of the site centroid from the WI DNR 2022 Urban Tree Canopy raster (1 m resolution, derived from NAIP aerial imagery).</p>
            <div class="shp-formula">canopy % = treePixels / validPixels × 100<br>Tree pixel: RGBA where R≤15, G=165–195, B≤15<br>(colormap: tree → rgb(0,180,0), non-tree → rgb(100,70,20))</div>
            <p>Tiers: ≤30% Low (gray), 31–55% Moderate (green), &gt;55% High (dark green). The Shaded Habitat alert fires above 55%. WI DNR advises against directly comparing survey years.</p>
            <p class="shp-source">Source: WI DNR Urban Forestry · FR_Urban_Tree_Canopy_Raster_2022 ImageServer · 64×64 px exportImage · 24 h server cache</p>
          </div>
        </div>
      </div>
      <div class="drawer-nesting-row"
           role="img"
           aria-label="Tree canopy coverage: ${pct}% — ${levelLbl}.">
        <div class="drawer-nesting-score" style="background:${color};">${pct}%</div>
        <div class="drawer-nesting-detail">
          <span class="drawer-nesting-label" style="color:${color};">${esc(levelLbl)}</span>
          <span class="drawer-nesting-desc">Based on 1 m NAIP imagery. High canopy cover (&gt;55%) may warrant selective thinning to improve sun exposure for pollinator plants.</span>
        </div>
      </div>`;
  })();
  // ── Urban Habitat Index context score (InVEST crosswalk) ─────────────────────
  const investHtml = (() => {
    if (src !== 'gbcc-corridor') return '';
    const key   = p.name || p.registrant || '';
    const match = _investCrosswalk.find(x => x.name === key);
    if (!match) return '';
    const pct   = Math.round(match.investScore * 100);
    const tier  = pct >= 70 ? 'High' : pct >= 35 ? 'Moderate' : 'Low';
    const color = pct >= 70 ? '#7c3aed' : pct >= 35 ? '#8b5cf6' : '#a78bfa';
    return `
      <div class="drawer-section-label">Urban habitat context (adapted InVEST, 660\u202fm grid)</div>
      <div class="drawer-nesting-row">
        <div class="drawer-nesting-score" style="background:${color};">${pct}</div>
        <div class="drawer-nesting-detail">
          <span class="drawer-nesting-label" style="color:${color};">Urban Habitat Index \u2014 ${tier}</span>
          <span class="drawer-nesting-desc">Derived from the InVEST Lonsdorf\u00a0(2009) model, originally calibrated for farmland. Score is relative to other developed land in the study area \u2014 not to rural habitat. Reflects surrounding NLCD land cover within 660\u202fm, not the specific plantings here. Enable \u201cUrban Habitat Index\u201d in the Analysis pane to view the full heatmap.</span>
        </div>
      </div>`;
  })();

  const nearbyParcelsHtml = isApprox ? '' : _buildNearbyParcelsSection(coord);
  const nearbyPhotosHtml  = _buildNearbyPhotosSection(coord);

  // Monarch migration phenology notice — shown only for waystation drawers
  const migrationHtml = (() => {
    if (src !== 'waystation') return '';
    const now = new Date();
    const m = now.getMonth(), d = now.getDate();
    // Monarch Watch timing for 44.5°N (Green Bay): Aug 28 – Sep 15, peak ~Sep 8
    const inWindow = (m === 7 && d >= 28) || (m === 8 && d <= 15);
    if (inWindow) {
      return `<p style="margin:0 0 8px;padding:4px 9px;font-size:11px;line-height:1.45;border-radius:4px;background:rgba(245,158,11,0.13);border:1px solid rgba(245,158,11,0.32);color:#f59e0b;font-weight:600;">&#x1F98B; Fall migration window active: Aug 28 \u2013 Sep 15 &middot; Peak ~Sep 8 (Green Bay, 44.5&#xb0;N)</p>`;
    }
    return `<p style="margin:0 0 8px;padding:3px 9px;font-size:11px;line-height:1.45;border-radius:4px;color:#6b7280;">Fall migration window: Aug 28 \u2013 Sep 15 (Green Bay area)</p>`;
  })();

  // ── Alert context (problem-area / expansion-opportunity overlaps) ────────────
  const alertContextHtml = alertFeatures.length ? (() => {
    const rows = alertFeatures.map(f => {
      const ap = f.properties;
      if (ap.layer_id === 'problem-areas') {
        const sev      = ap.severity ?? 'medium';
        const sevColor = sev === 'high' ? '#dc2626' : sev === 'medium' ? '#d97706' : '#6b7280';
        const typeLabel = _problemTypeLabel(ap.problem_type ?? '');
        return `<div class="drawer-alert-row" style="border-left-color:${sevColor}">
          <span class="drawer-alert-label" style="color:${sevColor}">&#x26A0; Problem Area &mdash; ${typeLabel}</span>
          ${ap.common ? `<span class="drawer-alert-sub">${esc(ap.common)}</span>` : ''}
        </div>`;
      }
      if (ap.layer_id === 'expansion-opportunities') {
        const suit     = ap.suitability ?? 'moderate';
        const barColor = suit === 'good' ? '#10b981' : suit === 'moderate' ? '#f59e0b' : '#ef4444';
        return `<div class="drawer-alert-row" style="border-left-color:${barColor}">
          <span class="drawer-alert-label" style="color:${barColor}">&#x26A1; Expansion Opportunity &mdash; ${suit} suitability (${ap.score ?? 0}/100)</span>
        </div>`;
      }
      return '';
    }).filter(Boolean).join('');
    return rows ? `<div class="drawer-alert-context">${rows}</div>` : '';
  })() : '';

  body.innerHTML = `
    <div class="drawer-header" style="background:${headerColor};">
      <div class="drawer-header-label">${esc(titleLabel)}</div>
      <h2 class="drawer-title">${esc(p.name || p.registrant || 'Site')}</h2>
    </div>
    <div class="drawer-content">
      ${alertContextHtml}
      ${approxHtml}
      ${metaHtml}
      ${migrationHtml}
      ${nestingHtml}
      ${canopyHtml}
      ${investHtml}
      ${nearbyParcelsHtml}
      ${corridorConnHtml}
      <div class="drawer-section-label">Sighting activity nearby</div>
      ${nearbySightingsHtml}
      ${nearbySitesHtml}
      ${nearbyPhotosHtml}
      ${linkHtml}
    </div>`;

  // Wire parcel copy buttons
  body.querySelectorAll('.parcel-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const addr = btn.dataset.address;
      navigator.clipboard?.writeText(addr).catch(() => {}).finally(() => {
        const conf = btn.querySelector('.copy-confirm');
        if (conf) {
          conf.textContent = 'Address copied';
          setTimeout(() => { conf.textContent = ''; }, 1600);
        }
      });
    });
  });

  // Wire commons photo thumbnails → lightbox
  if (_commonsImages.length) {
    const photoMap = new Map(_commonsImages.map(img => [String(img.pageId), img]));
    body.querySelectorAll('.commons-photo-thumb-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const img = photoMap.get(btn.dataset.pageId);
        if (img) openLightbox(img);
      });
    });
  }

  drawer.classList.add('drawer--open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('site-drawer-close')?.focus();
}

export function closeDrawer() {
  const drawer = document.getElementById('site-drawer');
  if (!drawer) return;
  drawer.classList.remove('drawer--open');
  drawer.setAttribute('aria-hidden', 'true');
}

/**
 * Open the drawer with a plain title and arbitrary HTML body.
 * Used by intel-bar stats to surface summary data panels.
 *
 * @param {string} title    Heading shown at the top of the drawer
 * @param {string} bodyHtml HTML string for the drawer body content
 */
export function openIntelDrawer(title, bodyHtml, { headerStyle = '', labelHtml = '' } = {}) {
  const drawer = document.getElementById('site-drawer');
  const body   = document.getElementById('site-drawer-body');
  if (!drawer || !body) return;
  body.innerHTML =
    `<div class="drawer-header"${headerStyle ? ` style="${headerStyle}"` : ''}>` +
      (labelHtml ? `<div class="drawer-header-label">${labelHtml}</div>` : '') +
      `<h2 class="drawer-title">${title}</h2>` +
    `</div>` +
    `<div class="drawer-body">${bodyHtml}</div>`;
  drawer.scrollTop = 0;
  drawer.classList.add('drawer--open');
  drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('site-drawer-close')?.focus();
}

/** Returns true if the feature should open the drawer rather than a popup. */
export function isDrawerFeature(props) {
  const drawerSources = new Set([
    'gbcc-corridor', 'waystation', 'gbcc-treatment',
    'padus', 'dnr-sna', 'dnr-managed', 'dnr-pfas',
  ]);
  return drawerSources.has(props?.data_source);
}
