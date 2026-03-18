/**
 * ui.js — DOM panel, legend, and popup rendering.
 *
 * All functions that touch the DOM live here so they can be called from app.js.
 * HTML escaping is centralised in `esc()` — never skip it for user/API data.
 */

import { ESTABLISHMENT, AREA_LAYERS, HAZARD_LAYERS, WAYSTATION_LAYER } from './config.js';

// ── Security helper ──────────────────────────────────────────────────────────

/**
 * Escapes a value for safe insertion into HTML attribute or text content.
 * Must be used on all data originating from the iNaturalist API.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ── Panel construction ───────────────────────────────────────────────────────

/**
 * Populates the "Layers" panel section with toggle rows, organised into
 * named groups (e.g. iNaturalist vs GBIF).
 *
 * @param {Array<{groupLabel: string, layers: object[]}>} groups
 * @param {function(id: string, visible: boolean): void}  onToggle
 *   Callback invoked when a toggle changes.
 * @param {HTMLElement|null} [container]
 *   Optional container element. Defaults to #panel-layers.
 * @param {function(id: string, opacity: number): void} [onOpacity]
 *   Optional callback invoked when an opacity slider changes (0–1).
 */
export function buildLayerPanel(groups, onToggle, container = null, onOpacity = null) {
  const section = container ?? document.getElementById('panel-layers');

  for (const { groupLabel, layers } of groups) {
    const header = document.createElement('p');
    header.className = 'layer-group-label';
    header.textContent = groupLabel;
    section.appendChild(header);

    for (const layer of layers) {
      const storedOpacity = parseFloat(localStorage.getItem(`opacity:${layer.id}`));
      const initOpacity   = isNaN(storedOpacity) ? 1.0 : storedOpacity;

      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <label class="layer-row" for="toggle-${esc(layer.id)}">
          <div class="toggle">
            <input type="checkbox"
                   id="toggle-${esc(layer.id)}"
                   ${layer.defaultOn ? 'checked' : ''}
                   aria-label="${esc(layer.label)} layer">
            <div class="toggle-track" aria-hidden="true"></div>
          </div>
          <span class="layer-emoji" aria-hidden="true">${layer.emoji}</span>
          <span class="layer-label">${esc(layer.label)}</span>
          <span class="layer-count" id="count-${esc(layer.id)}" aria-live="polite">—</span>
        </label>
        <p class="layer-desc">${esc(layer.description)}</p>
        ${onOpacity ? `<div class="layer-opacity-row">
          <label class="layer-opacity-label" for="opacity-${esc(layer.id)}">Opacity</label>
          <input type="range" class="layer-opacity-slider"
                 id="opacity-${esc(layer.id)}"
                 min="0" max="1" step="0.05"
                 value="${initOpacity}"
                 aria-label="${esc(layer.label)} opacity">
        </div>` : ''}`;

      section.appendChild(wrap);

      wrap.querySelector('input[type="checkbox"]').addEventListener('change', e => {
        onToggle(layer.id, /** @type {HTMLInputElement} */ (e.target).checked);
      });

      if (onOpacity) {
        const slider = wrap.querySelector('input[type="range"]');
        // Apply stored opacity on mount
        if (initOpacity !== 1.0) onOpacity(layer.id, initOpacity);
        slider.addEventListener('input', () => {
          const val = parseFloat(slider.value);
          localStorage.setItem(`opacity:${layer.id}`, val);
          onOpacity(layer.id, val);
        });
      }
    }
  }
}

/**
 * Populates the "Establishment · ring color" legend section.
 */
export function buildEstLegend() {
  const section = document.getElementById('panel-est-inner');
  const keys    = ['native', 'endemic', 'introduced', 'invasive', 'unknown'];

  for (const key of keys) {
    const conf = ESTABLISHMENT[key];
    const row  = document.createElement('div');
    row.className = 'est-row';
    row.innerHTML = `
      <div class="est-dot"
           style="border-color: ${esc(conf.color)};"
           aria-hidden="true"></div>
      <span>${esc(conf.label)}</span>`;
    section.appendChild(row);
  }
}

/**
 * Populates the area-type color legend in #panel-area-legend.
 * Each row is a toggle button — clicking it calls onToggle(id, visible)
 * and visually dims the row when turned off.
 *
 * @param {function(id: string, visible: boolean): void} [onToggle]
 */
export function buildAreaLegend(onToggle = null) {
  const section = document.getElementById('panel-area-legend-inner');
  if (!section) return;

  /**
   * Creates one legend row as a <button> (when onToggle supplied) or a <div>.
   * State is stored in the DOM via the `area-legend-row--off` class so that
   * external callers (e.g. panel checkboxes, alert clicks) can sync the visual
   * state without needing access to a private state map.
   * @param {string}  id         — logical layer id
   * @param {string}  swatchHtml — inner HTML for the colour indicator
   * @param {string}  labelText  — plain text label
   * @param {boolean} defaultOn  — initial visibility
   */
  function makeRow(id, swatchHtml, labelText, defaultOn) {
    const el = document.createElement(onToggle ? 'button' : 'div');
    el.className = `area-legend-row${defaultOn ? '' : ' area-legend-row--off'}`;
    el.dataset.layerId = id;
    if (onToggle) {
      el.type  = 'button';
      el.title = `Toggle ${labelText}`;
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = labelText;

    const swatchWrap = document.createElement('span');
    swatchWrap.innerHTML = swatchHtml;

    el.appendChild(swatchWrap.firstElementChild);
    el.appendChild(labelSpan);

    if (onToggle) {
      el.addEventListener('click', () => {
        // Derive current state from CSS so external updates (checkbox, alert
        // click) are always in sync — no private state map needed.
        const newVisible = el.classList.contains('area-legend-row--off');
        onToggle(id, newVisible);
      });
    }

    section.appendChild(el);
  }

  for (const layer of AREA_LAYERS) {
    makeRow(
      layer.id,
      `<div class="area-legend-swatch"
           style="background:${esc(layer.fillColor)};border-color:${esc(layer.outlineColor)};"
           aria-hidden="true"></div>`,
      layer.label,
      layer.defaultOn,
    );
  }

  // Waystation layer (violet circle)
  makeRow(
    WAYSTATION_LAYER[0].id,
    `<div class="area-legend-waystation"
         style="background:#8b5cf6;"
         aria-hidden="true">&#9670;</div>`,
    WAYSTATION_LAYER[0].label,
    WAYSTATION_LAYER[0].defaultOn,
  );

  // Hazard layer (red circle)
  makeRow(
    HAZARD_LAYERS[0].id,
    `<div class="area-legend-circle"
         style="background:#ef4444;"
         aria-hidden="true"></div>`,
    HAZARD_LAYERS[0].label,
    HAZARD_LAYERS[0].defaultOn,
  );
}

// ── Status updates ───────────────────────────────────────────────────────────

/**
 * Updates observation counts in the layer toggle labels.
 *
 * @param {Record<string, number>} counts - map of layer id → count
 */
export function updateCounts(counts) {
  for (const [id, count] of Object.entries(counts)) {
    const el = document.getElementById(`count-${id}`);
    if (el) el.textContent = count.toLocaleString();
  }
}

/** Shows or hides the loading spinner. */
export function setLoading(on) {
  const loading = document.getElementById('loading');
  const btn     = document.getElementById('btn-reload');
  if (loading) loading.hidden = !on;
  if (btn)     btn.disabled   = on;
}

/** Updates the header status badge. */
export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Returns a default date range of the past 3 years.
 * @returns {{ from: string, to: string }} ISO date strings (YYYY-MM-DD)
 */
export function getDefaultDates() {
  const today = new Date();
  const from  = new Date(today);
  from.setFullYear(today.getFullYear() - 1);
  return {
    from: from.toISOString().slice(0, 10),
    to:   today.toISOString().slice(0, 10),
  };
}

// ── Popup ────────────────────────────────────────────────────────────────────

/**
 * Builds the inner HTML for a MapLibre popup from a point feature's properties.
 *
 * Colors come from the in-memory ESTABLISHMENT config here in the main thread.
 * This function is NOT called from the tile worker, so it is safe to use
 * ESTABLISHMENT[est_key].color without any tile-worker null-type concerns.
 *
 * @param {Record<string, unknown>} props - feature.properties from MapLibre
 * @returns {string} safe HTML string
 */
export function buildPopupHTML(props) {
  // eBird sightings have their own property schema (no est_key, no user field)
  if (props.layer_id === 'ebird') {
    const countHtml = props.how_many
      ? `<dt>Count</dt><dd>${esc(props.how_many)}</dd>`
      : '';
    const locHtml = props.loc_name
      ? `<dt>Location</dt><dd>${esc(props.loc_name)}</dd>`
      : '';
    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.common || props.name)}</strong>
        ${props.common ? `<em class="popup-sci">${esc(props.name)}</em>` : ''}
        <span class="popup-source">eBird · Cornell Lab</span>
        <dl class="popup-meta">
          <dt>Date</dt><dd>${esc(props.date) || '—'}</dd>
          ${countHtml}
          ${locHtml}
        </dl>
        ${props.url
          ? `<a class="popup-link" href="${esc(props.url)}" target="_blank" rel="noopener noreferrer">View on eBird →</a>`
          : ''}
      </div>`;
  }

  const conf    = ESTABLISHMENT[props.est_key] ?? ESTABLISHMENT.unknown;
  const isGbif  = props.source === 'gbif';

  const imgHtml = props.image
    ? `<img src="${esc(props.image)}"
            alt="${esc(props.common || props.name)}"
            loading="lazy"
            style="width:100%;height:130px;object-fit:cover;display:block;">`
    : '';

  const sourceHtml = isGbif && props.dataset
    ? `<span class="popup-source">GBIF · ${esc(props.dataset)}</span>`
    : '';

  const linkLabel = isGbif ? 'View on GBIF' : 'View on iNaturalist';

  return `
    ${imgHtml}
    <div class="popup-body">
      <strong class="popup-name">${esc(props.common || props.name)}</strong>
      ${props.common ? `<em class="popup-sci">${esc(props.name)}</em>` : ''}
      ${sourceHtml}
      <span class="popup-est-badge"
            style="background: ${esc(conf.color)};">● ${esc(props.est_label || conf.label)}</span>
      <dl class="popup-meta">
        <dt>Date</dt>     <dd>${esc(props.date) || '—'}</dd>
        <dt>Observer</dt> <dd>${esc(props.user) || '—'}</dd>
      </dl>
      <a class="popup-link"
         href="${esc(props.url)}"
         target="_blank"
         rel="noopener noreferrer">${esc(linkLabel)} →</a>
    </div>`;
}

// ── Area / hazard popup ───────────────────────────────────────────────────────

/**
 * Builds popup HTML for polygon area features (PAD-US, DNR SNA, DNR Managed)
 * and hazard monitoring stations (WQP pesticide).
 *
 * @param {Record<string, unknown>} props - feature.properties
 * @returns {string} safe HTML string
 */
export function buildAreaPopupHTML(props) {
  const src = props.data_source;

  if (src === 'padus') {
    const rows = [
      props.manager      && ['Manager',      props.manager],
      props.manager_type && ['Type',          props.manager_type],
      props.designation  && ['Designation',   props.designation],
      props.public_access && ['Access',       props.public_access],
      props.gap_status   && ['Protection',    props.gap_status],
    ].filter(Boolean);

    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">USGS PAD-US v3.0</span>
        <dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>
      </div>`;
  }

  if (src === 'dnr-sna') {
    const acresLabel = props.acres ? `${(+props.acres).toFixed(0)} acres` : null;
    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">WI DNR State Natural Area</span>
        ${acresLabel ? `<dl class="popup-meta"><dt>Area</dt><dd>${esc(acresLabel)}</dd></dl>` : ''}
        ${props.url
          ? `<a class="popup-link" href="${esc(props.url)}" target="_blank" rel="noopener noreferrer">SNA details →</a>`
          : ''}
      </div>`;
  }

  if (src === 'dnr-managed') {
    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">WI DNR Managed Land</span>
      </div>`;
  }

  if (src === 'gbcc-corridor') {
    const rows = [
      props.area_sqft  && ['Area',       `${(+props.area_sqft).toLocaleString()} sq ft`],
      props.plant_list && ['Plant list', props.plant_list],
    ].filter(Boolean);

    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">🦋 NE Wisconsin Pollinator Corridor · GBCC</span>
        ${rows.length ? `<dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>` : ''}
        <a class="popup-link"
           href="https://storymaps.arcgis.com/stories/9f4ca337f8ed486ab8422be9ef8015a3"
           target="_blank" rel="noopener noreferrer">Corridor StoryMap →</a>
      </div>`;
  }

  if (src === 'gbcc-treatment') {
    const rows = [
      props.treatment_type && ['Treatment',  props.treatment_type],
      props.date           && ['Date',        props.date],
      props.acres          && ['Area',        `${props.acres} acres`],
    ].filter(Boolean);

    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.treatment_type || 'Habitat Treatment')}</strong>
        <span class="popup-source">🌱 GBCC Habitat Restoration Treatment</span>
        ${rows.length ? `<dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>` : ''}
      </div>`;
  }

  if (src === 'waystation') {
    const typeLabels = {
      home:             'Private garden',
      school:           'School',
      zoo:              'Zoo',
      nature_center:    'Nature / Education Center',
      org:              'Organization',
      community:        'Neighborhood / Community',
      place_of_worship: 'Religious institution',
    };
    const rows = [
      props.registrant !== props.name && ['Registrant', props.registrant],
      props.registered               && ['Registered',   props.registered],
      props.size                     && ['Habitat size', props.size],
      props.type                     && ['Setting',      typeLabels[props.type] ?? props.type],
    ].filter(Boolean);

    const approxNotice = props.approximate
      ? `<p class="popup-approx">&#9432; Approximate location — precise address not confirmed in public records. Placed within zip code area only.</p>`
      : '';

    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name || props.registrant)}</strong>
        <span class="popup-source">🦋 Monarch Watch Waystation #${esc(props.ws_id)}</span>
        ${approxNotice}
        ${rows.length ? `<dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>` : ''}
        <a class="popup-link"
           href="https://www.monarchwatch.org/waystations/"
           target="_blank" rel="noopener noreferrer">About Waystations →</a>
      </div>`;
  }

  if (src === 'dnr-pfas') {
    const rows = [
      props.year        && ['Year sampled',  props.year],
      props.pfos        && ['PFOS (ng/L)',    props.pfos],
      props.pfoa        && ['PFOA (ng/L)',    props.pfoa],
      props.surface_water && ['Surface water', 'Detected'],
    ].filter(Boolean);

    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source area-hazard-badge">⚠️ PFAS Contamination Site · WI DNR</span>
        ${rows.length ? `<dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>` : ''}
        ${props.url
          ? `<a class="popup-link" href="${esc(props.url)}" target="_blank" rel="noopener noreferrer">DNR report →</a>`
          : ''}
      </div>`;
  }

  if (src === 'hnp') {
    const isOrg = props.org_type === 'ORGANIZATIONS';
    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">🌿 Homegrown National Park${isOrg ? ' · Organization' : ''}</span>
        <a class="popup-link"
           href="https://homegrownnationalpark.org/"
           target="_blank" rel="noopener noreferrer">About HNP →</a>
      </div>`;
  }

  // Fallback — should never occur
  return `<div class="popup-body"><strong>${esc(props.name || 'Feature')}</strong></div>`;
}
