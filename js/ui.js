/**
 * ui.js — DOM panel, legend, and popup rendering.
 *
 * All functions that touch the DOM live here so they can be called from app.js.
 * HTML escaping is centralised in `esc()` — never skip it for user/API data.
 */

import { ESTABLISHMENT } from './config.js';

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
 */
export function buildLayerPanel(groups, onToggle) {
  const section = document.getElementById('panel-layers');

  for (const { groupLabel, layers } of groups) {
    const header = document.createElement('p');
    header.className = 'layer-group-label';
    header.textContent = groupLabel;
    section.appendChild(header);

    for (const layer of layers) {
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
        <p class="layer-desc">${esc(layer.description)}</p>`;

      section.appendChild(wrap);

      wrap.querySelector('input').addEventListener('change', e => {
        onToggle(layer.id, /** @type {HTMLInputElement} */ (e.target).checked);
      });
    }
  }
}

/**
 * Populates the "Establishment · ring color" legend section.
 */
export function buildEstLegend() {
  const section = document.getElementById('panel-est');
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
  from.setFullYear(today.getFullYear() - 3);
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
