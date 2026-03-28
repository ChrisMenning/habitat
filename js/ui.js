/**
 * ui.js — DOM panel, legend, and popup rendering.
 *
 * All functions that touch the DOM live here so they can be called from app.js.
 * HTML escaping is centralised in `esc()` — never skip it for user/API data.
 */

import { ESTABLISHMENT, LAYERS, GBIF_LAYERS, AREA_LAYERS, HAZARD_LAYERS,
         WAYSTATION_LAYER, HNP_LAYER, EBIRD_LAYER, BEE_LAYERS,
         LAYER_VINTAGES } from './config.js';

// ── Pesticide legend ──────────────────────────────────────────────────────────

// Band definitions used in both the MapLibre paint expression and this legend.
const _PESTICIDE_BANDS = [
  { band: 1, label: 'Low',      desc: 'score < 0.45 · forest / low-input dairy',      color: '#fef9c3', border: '#92400e', dashed: false },
  { band: 2, label: 'Moderate', desc: '0.45–0.60 · mixed dairy / row-crop transition', color: '#fbbf24', border: '#92400e', dashed: false },
  { band: 3, label: 'High',     desc: '0.60–0.70 · significant corn/soy + insecticide', color: '#f97316', border: '#c2410c', dashed: true  },
  { band: 4, label: 'Critical', desc: '≥ 0.70 · dominant row-crop + neonicotinoids',   color: '#dc2626', border: '#991b1b', dashed: true  },
];

/**
 * Appends the pesticide pressure choropleth legend to a container element.
 * Includes labeled color swatches and a brief methodology note to satisfy
 * WCAG SC 1.4.1 (color not the only conveyed channel).
 *
 * @param {HTMLElement} container - element to append the legend into
 */
export function buildPesticideLegend(container) {
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'pesticide-legend';
  wrap.setAttribute('aria-label', 'Pesticide pressure band legend');
  const title = document.createElement('p');
  title.className = 'pesticide-legend-title';
  title.textContent = '🧪 Pesticide Pressure — intensity bands';
  wrap.appendChild(title);
  for (const b of _PESTICIDE_BANDS) {
    const row = document.createElement('div');
    row.className = 'pesticide-legend-row';
    row.setAttribute('role', 'listitem');
    const swatch = document.createElement('div');
    swatch.className = `pesticide-legend-swatch${b.dashed ? ' pesticide-legend-swatch--dashed' : ''}`;
    swatch.style.cssText = `background:${b.color};border-color:${b.border};`;
    swatch.setAttribute('aria-hidden', 'true');
    const bandLabel = document.createElement('span');
    bandLabel.className = 'pesticide-legend-band';
    bandLabel.textContent = `Band ${b.band}`;
    const label = document.createElement('span');
    label.className = 'pesticide-legend-label';
    label.textContent = b.label;
    const desc = document.createElement('span');
    desc.className = 'pesticide-legend-desc';
    desc.textContent = b.desc;
    row.appendChild(swatch);
    row.appendChild(bandLabel);
    row.appendChild(label);
    row.appendChild(desc);
    wrap.appendChild(row);
  }
  const note = document.createElement('p');
  note.className = 'pesticide-legend-note';
  note.textContent = 'Proxy derived from USDA CDL crop mix × application rate lookup. Dashed border = top-half intensity (bands 3–4).';
  wrap.appendChild(note);
  container.appendChild(wrap);
}

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

      const _vintage = layer.vintage ?? LAYER_VINTAGES.get(layer.id) ?? null;
      const _vintageTitle = _vintage
        ? `title="Data vintage: ${_vintage.year}. This layer does not update automatically. Comparisons with live observations may be inaccurate."`
        : '';
      const _vintageBadge = _vintage
        ? `<span class="layer-vintage-badge" aria-label="Data vintage ${_vintage.year}">${_vintage.year}</span>`
        : '';

      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <label class="layer-row" for="toggle-${esc(layer.id)}" ${_vintageTitle}>
          <div class="toggle">
            <input type="checkbox"
                   id="toggle-${esc(layer.id)}"
                   ${layer.defaultOn ? 'checked' : ''}
                   aria-label="${esc(layer.label)} layer">
            <div class="toggle-track" aria-hidden="true"></div>
          </div>
          <span class="layer-emoji" aria-hidden="true">${layer.emoji}</span>
          <span class="layer-label">${esc(layer.label)}</span>${_vintageBadge}
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

  function addGroupLabel(text) {
    const h = document.createElement('p');
    h.className = 'layer-group-label';
    h.textContent = text;
    section.appendChild(h);
  }

  /**
   * Creates one legend row as a <button> (when onToggle supplied) or a <div>.
   * `data-layer-id` allows setLayerActive to sync visual state on toggle events.
   */
  function makeRow(id, swatchHtml, labelText, defaultOn, toggleable = true) {
    const el = document.createElement((onToggle && toggleable) ? 'button' : 'div');
    el.className = `area-legend-row${defaultOn ? '' : ' area-legend-row--off'}`;
    el.dataset.layerId = id;
    if (onToggle && toggleable) {
      el.type  = 'button';
      el.title = `Toggle ${labelText}`;
      el.setAttribute('aria-label', `Toggle ${labelText} — currently ${defaultOn ? 'on' : 'off'}`);
    }

    const swatchWrap = document.createElement('span');
    swatchWrap.innerHTML = swatchHtml;
    const labelSpan = document.createElement('span');
    labelSpan.textContent = labelText;

    el.appendChild(swatchWrap.firstElementChild);
    el.appendChild(labelSpan);

    if (onToggle && toggleable) {
      el.addEventListener('click', () => {
        const newVisible = el.classList.contains('area-legend-row--off');
        onToggle(id, newVisible);
        el.setAttribute('aria-label', `Toggle ${labelText} — currently ${newVisible ? 'on' : 'off'}`);
      });
    }
    section.appendChild(el);
  }

  // Helper for a simple colored circle swatch
  const circleSwatch = (color, border = color) =>
    `<div class="area-legend-circle" style="background:${esc(color)};outline:2px solid ${esc(border)};outline-offset:-1px;" aria-hidden="true"></div>`;

  // Helper for a semi-transparent area fill swatch
  const areaSwatch = (fill, border) =>
    `<div class="area-legend-swatch" style="background:${esc(fill)};border-color:${esc(border)};" aria-hidden="true"></div>`;

  // ── Habitat Sites (toggleable) ────────────────────────────────────────────
  addGroupLabel('Habitat Sites');
  // Pollinator Corridor (area polygon)
  const corridorCfg = AREA_LAYERS.find(l => l.id === 'gbcc-corridor');
  if (corridorCfg) makeRow(corridorCfg.id, areaSwatch(corridorCfg.fillColor, corridorCfg.outlineColor), corridorCfg.label, corridorCfg.defaultOn);
  // Monarch Waystations
  makeRow(
    WAYSTATION_LAYER[0].id,
    `<div class="area-legend-waystation" style="background:#8b5cf6;" aria-hidden="true">&#9670;</div>`,
    WAYSTATION_LAYER[0].label,
    WAYSTATION_LAYER[0].defaultOn,
  );
  // Monarch migration phenology hint — hardcoded Monarch Watch timing for Green Bay (44.5°N)
  (() => {
    const now = new Date();
    const m = now.getMonth(), d = now.getDate();
    // Window: Aug 28 (m=7,d=28) – Sep 15 (m=8,d=15); peak ~Sep 8
    const inWindow = (m === 7 && d >= 28) || (m === 8 && d <= 15);
    const note = document.createElement('p');
    note.setAttribute('aria-label', 'Monarch fall migration window for Green Bay area');
    if (inWindow) {
      note.style.cssText = 'margin:-2px 0 6px 28px;font-size:10px;line-height:1.4;padding:3px 7px;border-radius:3px;color:#f59e0b;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.30);font-weight:600;';
      note.innerHTML = '&#x1F98B; Migration window: Aug 28 &#x2013; Sep 15 &middot; Peak ~Sep 8';
    } else {
      note.style.cssText = 'margin:-2px 0 6px 28px;font-size:10px;line-height:1.4;padding:2px 6px;color:#6b7280;';
      note.textContent = 'Migration window: Aug 28 \u2013 Sep 15';
    }
    section.appendChild(note);
  })();
  // Homegrown National Park
  makeRow(
    HNP_LAYER[0].id,
    circleSwatch('#10b981', '#059669'),
    HNP_LAYER[0].label,
    HNP_LAYER[0].defaultOn,
  );

  // ── Conservation Areas (toggleable) ──────────────────────────────────────
  addGroupLabel('Conservation Areas');
  for (const layer of AREA_LAYERS.filter(l => l.id !== 'gbcc-corridor')) {
    makeRow(layer.id, areaSwatch(layer.fillColor, layer.outlineColor), layer.label, layer.defaultOn);
  }

  // ── Hazards (toggleable) ──────────────────────────────────────────────────
  addGroupLabel('Hazards');
  makeRow(HAZARD_LAYERS[0].id, circleSwatch('#ef4444', '#b91c1c'), HAZARD_LAYERS[0].label, HAZARD_LAYERS[0].defaultOn);

  // ── Sightings (info-only, not toggleable via legend) ─────────────────────
  addGroupLabel('Sightings · iNaturalist');
  const INAT_COLORS = { pollinators: '#10b981', 'native-plants': '#0891b2', 'other-plants': '#db2777', 'other-wildlife': '#92400e' };
  for (const layer of LAYERS) {
    makeRow(layer.id, circleSwatch(INAT_COLORS[layer.id] ?? '#6b7280'), layer.label, layer.defaultOn, false);
  }

  addGroupLabel('Sightings · GBIF (historical)');
  const GBIF_COLORS = { 'gbif-pollinators': '#10b981', 'gbif-native-plants': '#0891b2', 'gbif-non-native-plants': '#db2777', 'gbif-wildlife': '#92400e' };
  for (const layer of GBIF_LAYERS) {
    makeRow(layer.id, `<div class="area-legend-circle" style="background:${esc(GBIF_COLORS[layer.id] ?? '#6b7280')};opacity:0.5;outline:2px solid ${esc(GBIF_COLORS[layer.id] ?? '#6b7280')};outline-offset:-1px;" aria-hidden="true"></div>`, layer.label, layer.defaultOn, false);
  }

  addGroupLabel('Sightings · eBird');
  makeRow(EBIRD_LAYER[0].id, circleSwatch('#64748b', '#475569'), EBIRD_LAYER[0].label, EBIRD_LAYER[0].defaultOn, false);

  // ── Journey North Historical Monarchs (toggleable) ───────────────────────
  addGroupLabel('Sightings · Journey North (1996–2020)');
  makeRow(
    'journeynorth-monarchs',
    `<div class="area-legend-circle" style="background:#fb923c;outline:2px solid #f97316;outline-offset:-1px;" aria-hidden="true"></div>`,
    'Journey North Monarchs',
    false,  // off by default — requires pre-processed data file
    true,
  );
  (() => {
    const note = document.createElement('p');
    note.id = 'jn-monarchs-status';
    note.style.cssText = 'margin:-2px 0 6px 28px;font-size:10px;line-height:1.4;padding:2px 6px;color:#6b7280;';
    note.textContent = 'Historical · 1996–2020 (CC BY)';
    section.appendChild(note);
  })();

  addGroupLabel('Bee Distribution (FWS · GBIF)');
  const BEE_COLORS = { 'bees-records': '#f59e0b', 'bees-imperiled': '#ef4444' };
  for (const layer of BEE_LAYERS.filter(l => l.id !== 'bees-richness')) {
    makeRow(layer.id, circleSwatch(BEE_COLORS[layer.id] ?? '#f59e0b'), layer.label, layer.defaultOn, false);
  }
}

// ── Activity Bar controller ──────────────────────────────────────────────────

/**
 * Wires up the icon activity bar: toggle open/close of flyout panes,
 * keyboard navigation, focus management, and ARIA state.
 *
 * Panes use `aria-hidden` + `inert` (not `hidden`) so CSS opacity/transform
 * transitions play correctly — `[hidden]` is `display:none !important` which
 * prevents transitions from running.
 *
 * WCAG compliance:
 *   - Each button: `aria-pressed`, `aria-expanded`, `aria-controls`
 *   - Arrow keys navigate within the bar (roving focus)
 *   - Escape closes the flyout and returns focus to the triggering button
 *   - Opened pane receives focus on the close button
 *   - All panes have `role="region"` + `aria-label`
 *
 * @returns {{ openPane(id: string): void, closeAll(): void }}
 */
export function initActivityBar() {
  const bar    = document.getElementById('activity-bar');
  const flyout = document.getElementById('panel-flyout');
  if (!bar || !flyout) return { openPane() {}, closeAll() {} };

  const buttons  = [...bar.querySelectorAll('.ab-btn[data-flyout]')];
  let activePaneId = null;

  function _setButtonState(paneId) {
    buttons.forEach(btn => {
      const active = btn.dataset.flyout === paneId;
      btn.setAttribute('aria-pressed',  String(active));
      btn.setAttribute('aria-expanded', String(active));
      btn.classList.toggle('ab-btn--active', active);
    });
  }

  function openPane(paneId) {
    // Close currently open pane instantly (no transition — swapping content)
    if (activePaneId && activePaneId !== paneId) {
      const prev = document.getElementById(activePaneId);
      if (prev) {
        prev.classList.remove('flyout-pane--visible');
        prev.setAttribute('aria-hidden', 'true');
        prev.setAttribute('inert', '');
      }
    }

    const pane = document.getElementById(paneId);
    if (!pane) return;

    // 1. Make accessible & remove clip before transition
    pane.removeAttribute('aria-hidden');
    pane.removeAttribute('inert');

    // 2. Double-rAF: browser processes layout change, then CSS transition plays
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pane.classList.add('flyout-pane--visible');
      });
    });

    document.body.classList.add('flyout-open');
    _setButtonState(paneId);
    activePaneId = paneId;

    // Focus management: move to close button within the pane
    const closeBtn = pane.querySelector('.flyout-pane-close');
    setTimeout(() => closeBtn?.focus(), 60);
  }

  function closeAll() {
    if (!activePaneId) return;
    const prev     = document.getElementById(activePaneId);
    const prevId   = activePaneId;
    activePaneId   = null;

    if (prev) {
      prev.classList.remove('flyout-pane--visible');
      // Restore inert + aria-hidden after the transition completes
      const onEnd = () => {
        prev.setAttribute('aria-hidden', 'true');
        prev.setAttribute('inert', '');
        prev.removeEventListener('transitionend', onEnd);
      };
      prev.addEventListener('transitionend', onEnd);
    }

    document.body.classList.remove('flyout-open');
    _setButtonState(null);

    // Return focus to the bar button that opened this pane
    const origin = bar.querySelector(`[data-flyout="${prevId}"]`);
    setTimeout(() => origin?.focus(), 30);
  }

  // Activity bar button clicks — toggle same pane off, open new pane
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      activePaneId === btn.dataset.flyout ? closeAll() : openPane(btn.dataset.flyout);
    });
  });

  // Close buttons inside each pane
  flyout.querySelectorAll('.flyout-pane-close').forEach(btn => {
    btn.addEventListener('click', closeAll);
  });

  // Escape closes the flyout from anywhere
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && activePaneId) closeAll();
  });

  // Arrow-key roving focus within the activity bar (ARIA toolbar pattern)
  buttons.forEach((btn, i) => {
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        buttons[(i + 1) % buttons.length].focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        buttons[(i - 1 + buttons.length) % buttons.length].focus();
      }
    });
  });

  return { openPane, closeAll };
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

  // FWS Bee Distribution Tool layers — show family + conservation status
  if (props.source === 'gbif-bee') {
    const TIER_COLORS = {
      cr: { bg: '#ef4444', label: 'Critically Imperiled' },
      en: { bg: '#f97316', label: 'Endangered / Imperiled' },
      vu: { bg: '#f59e0b', label: 'Vulnerable' },
      nt: { bg: '#eab308', label: 'Near Threatened' },
    };
    const tier       = TIER_COLORS[props.conserv_tier];
    const statusHtml = tier
      ? `<span class="popup-est-badge" style="background:${esc(tier.bg)};">
           ● ${esc(tier.label)}${props.g_rank ? ` · ${esc(props.g_rank)}` : ''}
           ${props.iucn_cat ? ` · IUCN ${esc(props.iucn_cat)}` : ''}
         </span>
         ${props.conserv_note ? `<p style="font-size:0.72rem;margin:2px 0 4px;color:#6b7280;">${esc(props.conserv_note)}</p>` : ''}`
      : '';
    const imgHtml = props.image
      ? `<img src="${esc(props.image)}" alt="${esc(props.common || props.name)}"
              loading="lazy" style="width:100%;height:130px;object-fit:cover;display:block;">`
      : '';
    return `
      ${imgHtml}
      <div class="popup-body">
        <strong class="popup-name">${esc(props.common || props.name)}</strong>
        ${props.common ? `<em class="popup-sci">${esc(props.name)}</em>` : ''}
        <span class="popup-source">GBIF · FWS Bee Distribution · ${esc(props.dataset)}</span>
        ${statusHtml}
        <dl class="popup-meta">
          <dt>Family</dt>   <dd>${esc(props.family) || '—'}</dd>
          <dt>Date</dt>     <dd>${esc(props.date)   || '—'}</dd>
          <dt>Collected</dt><dd>${esc(props.user)   || '—'}</dd>
        </dl>
        ${props.url
          ? `<a class="popup-link" href="${esc(props.url)}" target="_blank" rel="noopener noreferrer">View on GBIF →</a>`
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
        <span class="popup-source area-hazard-badge"><i class="ph ph-warning" aria-hidden="true"></i> PFAS Contamination Site · WI DNR</span>
        ${rows.length ? `<dl class="popup-meta">
          ${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        </dl>` : ''}
        ${props.url
          ? `<a class="popup-link" href="${esc(props.url)}" target="_blank" rel="noopener noreferrer">DNR report →</a>`
          : ''}
      </div>`;
  }

  if (src === 'hnp') {
    const isOrg    = props.org_type === 'ORGANIZATIONS';
    const typeLabel = isOrg ? 'Member Organization' : 'Registered Yard';
    return `
      <div class="popup-body">
        <strong class="popup-name">${esc(props.name)}</strong>
        <span class="popup-source">🌿 HNP · ${typeLabel}</span>
        <a class="popup-link" href="https://map.homegrownnationalpark.org/" target="_blank" rel="noopener noreferrer">View on HNP Map ↗</a>
      </div>`;
  }

  // Fallback — should never occur
  return `<div class="popup-body"><strong>${esc(props.name || 'Feature')}</strong></div>`;
}

// ── Photo lightbox ────────────────────────────────────────────────────────────

/**
 * Opens the full-screen lightbox showing a Wikimedia Commons image.
 * Keyboard focus is moved to the close button; Escape / overlay-click closes.
 *
 * @param {{ thumburl:string, title:string, description:string, artist:string, license:string, descurl:string }} image
 */
export function openLightbox(image) {
  const overlay = document.getElementById('lightbox-overlay');
  if (!overlay) return;

  const imgEl     = document.getElementById('lightbox-img');
  const titleEl   = document.getElementById('lightbox-title');
  const artistEl  = document.getElementById('lightbox-artist');
  const licenseEl = document.getElementById('lightbox-license');
  const linkEl    = document.getElementById('lightbox-link');

  if (imgEl) {
    imgEl.src = image.thumburl;
    imgEl.alt = image.description || image.title;
  }
  if (titleEl)   titleEl.textContent   = image.description || image.title;
  if (artistEl)  artistEl.textContent  = image.artist;
  if (licenseEl) licenseEl.textContent = image.license;
  if (linkEl) {
    linkEl.href = image.descurl;
    linkEl.textContent = 'View on Wikimedia Commons ↗';
  }

  overlay.removeAttribute('hidden');
  overlay.querySelector('.lightbox-close')?.focus();
}

/**
 * Closes the photo lightbox overlay.
 */
export function closeLightbox() {
  document.getElementById('lightbox-overlay')?.setAttribute('hidden', '');
}
