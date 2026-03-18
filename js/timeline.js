/**
 * timeline.js — Year-range scrubber + month filter for sighting observations.
 *
 * The track always spans _trackMin → _trackMax regardless of what data is
 * currently loaded. Handles default to the full track (show everything).
 * Dragging a handle in-memory filters what's displayed without re-fetching.
 *
 * Design rules:
 *   • Handles can never cross or share the same year (MIN_GAP = 1).
 *   • The track floor is set at init time (default 2009) and can only expand.
 *   • An empty range on the map is acceptable and expected — it means no loaded
 *     data falls within the selected window.
 */

const MIN_GAP = 1; // minimum years between start and end handles

/** @type {function(startYear:number, endYear:number, activeMonths:Set<number>): void} */
let _onRange = null;

let _trackMin  = 2009;
let _trackMax  = new Date().getFullYear();
let _startYear = 2009;
let _endYear   = new Date().getFullYear();

/** Active calendar months (0=Jan…11=Dec). Empty = all months pass. */
const _activeMonths = new Set();

// ── Temporal layer registry ───────────────────────────────────────────────────
// Non-sighting layers (treatments, waystations) that have date fields register
// here. _applyTemporalLayers() filters them whenever the range changes.

/**
 * Map of { layerId → { features: GeoJSON.Feature[], onFilter: fn, dateGetter: fn } }
 */
const _temporalLayers = new Map();

/**
 * Register a non-sighting layer for timeline date filtering.
 *
 * @param {string}   layerId
 * @param {GeoJSON.Feature[]} features
 * @param {function(GeoJSON.Feature): string|number|undefined} dateGetter
 * @param {function(GeoJSON.Feature[]): void} onFilter
 */
export function registerTemporalLayer(layerId, features, dateGetter, onFilter) {
  _temporalLayers.set(layerId, { features, dateGetter, onFilter });
}

/** @param {string} layerId */
export function unregisterTemporalLayer(layerId) {
  _temporalLayers.delete(layerId);
}

/** Filter all registered temporal layers through the current year+month window. */
function _applyTemporalLayers() {
  for (const { features, dateGetter, onFilter } of _temporalLayers.values()) {
    const filtered = features.filter(f => {
      const raw = dateGetter(f);
      if (raw == null || raw === '') return true; // undated → always show
      let year, month;
      if (typeof raw === 'number') {
        const d = new Date(raw);
        year  = d.getFullYear();
        month = d.getMonth();
      } else {
        const s = String(raw).trim();
        if (/^\d{4}$/.test(s)) {
          year  = Number(s);
          month = -1; // year-only — skip month filter
        } else {
          const d = new Date(s);
          if (isNaN(d)) return true;
          year  = d.getFullYear();
          month = d.getMonth();
        }
      }
      if (isNaN(year))               return true;
      if (year < _startYear)         return false;
      if (year > _endYear)           return false;
      if (_activeMonths.size > 0 && month >= 0 && !_activeMonths.has(month)) return false;
      return true;
    });
    onFilter(filtered);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the timeline. Call once from map.on('load').
 *
 * @param {function(startYear:number, endYear:number, activeMonths:Set<number>): void} onRange
 * @param {number} [dataMinYear]  Historical floor for the track (default 2009).
 */
export function initTimeline(onRange, dataMinYear) {
  _onRange   = onRange;
  _trackMin  = dataMinYear ?? 2009;
  _trackMax  = new Date().getFullYear();
  // Default: show last 1 year
  _startYear = _trackMin;
  _endYear   = _trackMax;
  _render();
  _initMonthFilter();
  // Fire immediately so the date predicate is set before data arrives
  _onRange?.(_startYear, _endYear, _activeMonths);
}

/**
 * Expand the track bounds to encompass actual data years, if needed.
 * Never shrinks the track, never resets handles the user has already moved.
 * Call after each data load.
 *
 * @param {GeoJSON.Feature[]} allSightings
 */
export function updateTimelineBounds(allSightings) {
  let dataMin = Infinity, dataMax = -Infinity;
  for (const f of allSightings) {
    const raw = f.properties?.date;
    if (!raw) continue;
    const y = new Date(raw).getFullYear();
    if (!isNaN(y)) { dataMin = Math.min(dataMin, y); dataMax = Math.max(dataMax, y); }
  }
  if (dataMin === Infinity) return; // no dated sightings

  let changed = false;

  // Expand track floor if sightings go further back than current floor
  if (dataMin < _trackMin) {
    // Pull start handle back with the floor if it was sitting at the floor
    if (_startYear === _trackMin) _startYear = dataMin;
    _trackMin = dataMin;
    changed   = true;
  }

  // Expand track ceiling if sightings extend past current ceiling
  if (dataMax > _trackMax) {
    if (_endYear === _trackMax) _endYear = dataMax;
    _trackMax = dataMax;
    changed   = true;
  }

  // Clamp handles in case new track bounds broke the current selection
  const safeStart = Math.max(_trackMin, Math.min(_startYear, _trackMax - MIN_GAP));
  const safeEnd   = Math.min(_trackMax, Math.max(_endYear,   _trackMin + MIN_GAP));
  if (safeStart !== _startYear || safeEnd !== _endYear) {
    _startYear = safeStart;
    _endYear   = safeEnd;
    changed    = true;
  }

  if (changed) {
    _render();
    _onRange?.(_startYear, _endYear, _activeMonths);
  }
}

/**
 * Returns true if `dateStr` (YYYY-MM-DD) falls within the current window.
 *
 * @param {string|undefined} dateStr
 * @returns {boolean}
 */
export function datePassesTimeline(dateStr) {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d)) return true;
  const y = d.getFullYear();
  if (y < _startYear || y > _endYear) return false;
  if (_activeMonths.size > 0 && !_activeMonths.has(d.getMonth())) return false;
  return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/** Convert a year value to a percentage position on the track. */
function _pct(year) {
  const span = _trackMax - _trackMin;
  if (span === 0) return 0;
  return ((year - _trackMin) / span) * 100;
}

function _render() {
  const track = document.getElementById('timeline-track');
  if (!track) return;

  const pStart = _pct(_startYear);
  const pEnd   = _pct(_endYear);

  // Fill bar between the two handles
  const fill = track.querySelector('.timeline-fill');
  if (fill) {
    fill.style.left  = `${pStart}%`;
    fill.style.width = `${pEnd - pStart}%`;
  }

  // Start handle
  const hStart = track.querySelector('[data-handle="start"]');
  if (hStart) {
    hStart.style.left = `${pStart}%`;
    hStart.setAttribute('aria-valuenow',  _startYear);
    hStart.setAttribute('aria-valuemin',  _trackMin);
    hStart.setAttribute('aria-valuemax',  _endYear - MIN_GAP);
    hStart.setAttribute('aria-valuetext', `From ${_startYear}`);
  }

  // End handle
  const hEnd = track.querySelector('[data-handle="end"]');
  if (hEnd) {
    hEnd.style.left = `${pEnd}%`;
    hEnd.setAttribute('aria-valuenow',  _endYear);
    hEnd.setAttribute('aria-valuemin',  _startYear + MIN_GAP);
    hEnd.setAttribute('aria-valuemax',  _trackMax);
    hEnd.setAttribute('aria-valuetext', `To ${_endYear}`);
  }

  // Range label
  const label = document.getElementById('timeline-label');
  if (label) {
    label.textContent = (_startYear === _endYear)
      ? String(_startYear)
      : `${_startYear} – ${_endYear}`;
  }

  // Tick marks — only rebuild when track span changes
  const ticks = track.querySelector('.timeline-ticks');
  if (ticks) {
    const key = `${_trackMin}:${_trackMax}`;
    if (ticks.dataset.rangeKey !== key) {
      _buildTicks(ticks);
      ticks.dataset.rangeKey = key;
    }
  }
}

/** Build year-label tick marks spaced sensibly for the current span. */
function _buildTicks(ticks) {
  ticks.innerHTML = '';
  const span = _trackMax - _trackMin;
  const step = span <= 5 ? 1 : span <= 10 ? 2 : span <= 25 ? 5 : 10;
  const first = Math.ceil(_trackMin / step) * step;
  for (let y = first; y <= _trackMax; y += step) {
    const tick = document.createElement('span');
    tick.className    = 'timeline-tick';
    tick.style.left   = `${_pct(y)}%`;
    tick.dataset.year = y;
    ticks.appendChild(tick);
  }
}

// ── Drag interaction ──────────────────────────────────────────────────────────

/**
 * Mount pointer and keyboard listeners on the timeline track.
 * Call once after the DOM is ready (map.on('load')).
 */
export function mountTimelineDrag() {
  const track = document.getElementById('timeline-track');
  if (!track) return;

  function yearFromX(clientX) {
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(_trackMin + frac * (_trackMax - _trackMin));
  }

  function applyYear(which, rawYear) {
    if (which === 'start') {
      _startYear = Math.max(_trackMin, Math.min(rawYear, _endYear - MIN_GAP));
    } else {
      _endYear = Math.min(_trackMax, Math.max(rawYear, _startYear + MIN_GAP));
    }
    _render();
    _applyTemporalLayers();
    _onRange?.(_startYear, _endYear, _activeMonths);
  }

  // setPointerCapture keeps events coming even when pointer leaves the handle
  track.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-handle]');
    if (!handle) return;
    e.preventDefault();
    const which = handle.dataset.handle;
    handle.setPointerCapture(e.pointerId);
    function onMove(ev) { applyYear(which, yearFromX(ev.clientX)); }
    function onUp() {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup',   onUp);
      handle.removeEventListener('pointercancel', onUp);
    }
    handle.addEventListener('pointermove',  onMove);
    handle.addEventListener('pointerup',    onUp);
    handle.addEventListener('pointercancel', onUp);
  });

  // Keyboard support
  track.querySelectorAll('[data-handle]').forEach(handle => {
    handle.addEventListener('keydown', e => {
      const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      if (!delta) return;
      const cur = handle.dataset.handle === 'start' ? _startYear : _endYear;
      applyYear(handle.dataset.handle, cur + delta);
      e.preventDefault();
    });
  });
}

// ── Month filter ────────────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Builds and mounts the 12-month toggle button strip.
 * Buttons toggle individual calendar months on/off.
 * Called once from initTimeline().
 */
function _initMonthFilter() {
  const container = document.getElementById('month-filter-strip');
  if (!container) return;           // HTML element may not exist yet if called early
  container.innerHTML = '';         // idempotent — safe to call when tab re-mounts

  const row = document.createElement('div');
  row.className   = 'month-filter-row';
  row.setAttribute('role',       'group');
  row.setAttribute('aria-label', 'Filter by calendar month');

  for (let m = 0; m < 12; m++) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'month-btn';
    btn.textContent = MONTH_ABBR[m];
    btn.dataset.month = m;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label',   `${MONTH_ABBR[m]} — toggle month filter`);

    btn.addEventListener('click', () => {
      const mo = Number(btn.dataset.month);
      if (_activeMonths.has(mo)) {
        _activeMonths.delete(mo);
        btn.classList.remove('month-btn--active');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        _activeMonths.add(mo);
        btn.classList.add('month-btn--active');
        btn.setAttribute('aria-pressed', 'true');
      }
      _applyTemporalLayers();
      _onRange?.(_startYear, _endYear, _activeMonths);
    });

    row.appendChild(btn);
  }

  // “Clear months” reset button
  const clearBtn = document.createElement('button');
  clearBtn.type      = 'button';
  clearBtn.className = 'month-btn month-btn--clear';
  clearBtn.textContent = '× All';
  clearBtn.setAttribute('aria-label', 'Clear month filter — show all months');
  clearBtn.addEventListener('click', () => {
    _activeMonths.clear();
    row.querySelectorAll('.month-btn[data-month]').forEach(b => {
      b.classList.remove('month-btn--active');
      b.setAttribute('aria-pressed', 'false');
    });
    _applyTemporalLayers();
    _onRange?.(_startYear, _endYear, _activeMonths);
  });
  row.appendChild(clearBtn);

  container.appendChild(row);
}
