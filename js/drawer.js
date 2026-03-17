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

import { esc } from './ui.js';

const NEARBY_KM = 0.75;

/** All loaded pollinator sighting features — updated after each load. */
let _sightings = [];

/** All loaded habitat site features — updated after each load. */
let _habitatSites = [];

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

/**
 * Open the drawer with the given feature's dossier.
 * @param {GeoJSON.Feature} feature
 */
export function openDrawer(feature) {
  const drawer = document.getElementById('site-drawer');
  const body   = document.getElementById('site-drawer-body');
  if (!drawer || !body) return;

  const p    = feature.properties;
  const coord = featureCentroid(feature);

  // ── Nearby sightings ──────────────────────────────────────────────────────
  let nearbySightingsCount = 0;
  let nearbySpecies = new Set();
  if (coord) {
    for (const s of _sightings) {
      const sc = s.geometry?.coordinates;
      if (sc && distKm(coord, sc) <= NEARBY_KM) {
        nearbySightingsCount++;
        if (s.properties.common || s.properties.name) {
          nearbySpecies.add(s.properties.common || s.properties.name);
        }
      }
    }
  }
  const speciesList = [...nearbySpecies].slice(0, 5);

  // ── Nearby habitat sites ──────────────────────────────────────────────────
  const nearbySites = coord
    ? _habitatSites.filter(s => {
        const sc = featureCentroid(s);
        return sc && s !== feature && distKm(coord, sc) <= NEARBY_KM;
      })
    : [];

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
    add('Registrant',    p.registrant);
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
    ? `<p class="popup-approx" style="margin:8px 0 0;">ⓘ Approximate location — placed within zip code area only.</p>`
    : '';

  const nearbySightingsHtml = `
    <div class="drawer-stat-row">
      <div class="drawer-stat">
        <span class="drawer-stat-value">${nearbySightingsCount.toLocaleString()}</span>
        <span class="drawer-stat-label">Pollinator sightings within ${NEARBY_KM * 1000 | 0} m</span>
      </div>
      <div class="drawer-stat">
        <span class="drawer-stat-value">${nearbySpecies.size}</span>
        <span class="drawer-stat-label">Species observed</span>
      </div>
    </div>
    ${speciesList.length ? `<p class="drawer-species-list">${speciesList.map(s => `<span class="drawer-chip">${esc(s)}</span>`).join(' ')}</p>` : ''}
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

  body.innerHTML = `
    <div class="drawer-header" style="background:${headerColor};">
      <div class="drawer-header-label">${esc(titleLabel)}</div>
      <h2 class="drawer-title">${esc(p.name || p.registrant || 'Site')}</h2>
    </div>
    <div class="drawer-content">
      ${approxHtml}
      ${metaHtml}
      <div class="drawer-section-label">Sighting activity nearby</div>
      ${nearbySightingsHtml}
      ${nearbySitesHtml}
      ${linkHtml}
    </div>`;

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

/** Returns true if the feature should open the drawer rather than a popup. */
export function isDrawerFeature(props) {
  const drawerSources = new Set([
    'gbcc-corridor', 'waystation', 'gbcc-treatment',
    'padus', 'dnr-sna', 'dnr-managed', 'dnr-pfas',
  ]);
  return drawerSources.has(props?.data_source);
}
