/**
 * timeline.js — Year range scrubber + month filter for sighting observations.
 *
 * A horizontal dual-handle range slider mounted at the bottom of the map.
 * Dragging the handles filters the in-memory sighting features to only those
 * whose `date` property falls within the selected year range — no new API calls.
 *
 * A separate 12-button month strip lets users isolate observations by calendar
 * month without re-fetching from the network (client-side filter).
 *
 * Both filters are combined into a single date predicate, updated via the
 * callback provided at init time.
 */

/** @type {function(startYear:number, endYear:number, activeMonths:Set<number>): void} */
let _onRange = null;

let _minYear   = 2000;
let _maxYear   = new Date().getFullYear();
let _startYear = _maxYear - 1;
let _endYear   = _maxYear;

/**
 * Active calendar months (0=Jan … 11=Dec).
 * Empty set = all months shown (no month filter applied).
 */
const _activeMonths = new Set();

// ── Temporal layer registry ───────────────────────────────────────────────────
//
// Area/non-sighting layers that have usable date fields can register here so
// the timeline scrubber also filters their visible features when the range moves.
//
// Date field audit (Priority 1b):
//   iNat / GBIF sightings         — observed_on / eventDate → already handled
//   GBCC corridor sites           — no establishment/planting date field found
//                                   in the ArcGIS Feature Service (checked Park,
//                                   Area, PlantList fields — none are dated).
//   HNP yards                     — no registration date in the /api/guest/map/
//                                   plantings response; field absent from API.
//   Monarch Waystations           — 'registered' YYYY-MM-DD field available.
//   GBCC Habitat Treatments       — 'date' field (normalised from Treatment_Date_and_Time).
//   WI DNR PFAS sites             — 'year' field (string/number). Added as temporal layer.
//   eBird sightings               — 'obsDt' field (Priority 11, not yet loaded).
//   Wikimedia Commons photos      — DateTimeOriginal in extmetadata (Priority 10).

/**
 * Map of { layerId → { features: GeoJSON.Feature[], onFilter: fn, dateGetter: fn } }
 */
const _temporalLayers = new Map();

/**
 * Register a non-sighting layer for timeline date filtering.
 * When the year range or month filter changes, onFilter is called with
 * the subset of features whose date passes the current timeline state.
 *
 * @param {string}   layerId
 * @param {GeoJSON.Feature[]} features
 * @param {function(GeoJSON.Feature): string|number|undefined} dateGetter   Returns a date string (YYYY-MM-DD or YYYY) or epoch ms.
 * @param {function(GeoJSON.Feature[]): void} onFilter   Called with filtered feature array.
 */
export function registerTemporalLayer(layerId, features, dateGetter, onFilter) {
  _temporalLayers.set(layerId, { features, dateGetter, onFilter });
}

/**
 * Remove a temporal layer registration (call when data is stale / reloaded).
 * @param {string} layerId
 */
export function unregisterTemporalLayer(layerId) {
  _temporalLayers.delete(layerId);
}

/** Apply the current time window to all registered temporal layers. */
function _applyTemporalLayers() {
  for (const { features, dateGetter, onFilter } of _temporalLayers.values()) {
    const filtered = features.filter(f => {
      const raw = dateGetter(f);
      if (!raw) return true;
      let dateStr;
      if (typeof raw === 'number') {
        dateStr = new Date(raw).toISOString().slice(0, 10);
      } else {
        dateStr = String(raw).trim();
        // Year-only values — treat as January 1 of that year
        if (/^\d{4}$/.test(dateStr)) dateStr = `${dateStr}-01-01`;
      }
      const d = new Date(dateStr);
      if (isNaN(d)) return true;
      const y = d.getFullYear();
      if (y < _startYear || y > _endYear) return false;
      if (_activeMonths.size > 0 && !_activeMonths.has(d.getMonth())) return false;
      return true;
    });
    onFilter(filtered);
  }
}

/** Returns the active layers caption text. */
function _buildCaption() {
  const parts = ['🦋 Sightings'];
  if (_temporalLayers.has('gbcc-treatment')) parts.push('Treatments');
  if (_temporalLayers.has('waystations'))    parts.push('Waystations');
  return parts.join(' · ');
}

/** Updates the timeline caption element to reflect which layers are date-filtered. */
function _updateCaption() {
  const el = document.getElementById('timeline-caption');
  if (el) el.textContent = _buildCaption();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the timeline scrubber.
 *
 * @param {function(startYear:number, endYear:number, activeMonths:Set<number>): void} onRange
 *   Called whenever the selected range or active months change.
 * @param {number} [dataMinYear]  Earliest year present in loaded data.
 */
export function initTimeline(onRange, dataMinYear) {
  _onRange   = onRange;
  _minYear   = dataMinYear ?? 2000;
  _maxYear   = new Date().getFullYear();
  // Default: show last 1 year
  _startYear = _maxYear - 1;
  _endYear   = _maxYear;
  _render();
  _updateCaption();
  _initMonthFilter();
}

/**
 * Update the scrubber's year bounds based on the current dataset's date range.
 * Call this after each data load.
 *
 * @param {GeoJSON.Feature[]} allSightings
 */
export function updateTimelineBounds(allSightings) {
  let min = Infinity, max = -Infinity;
  for (const f of allSightings) {
    const y = f.properties?.date ? new Date(f.properties.date).getFullYear() : NaN;
    if (!isNaN(y)) { min = Math.min(min, y); max = Math.max(max, y); }
  }
  if (min === Infinity) return;  // no dated features
  const changed = min !== _minYear || max !== _maxYear;
  _minYear = min;
  _maxYear = max;
  // Clamp handles inside the new data bounds; if they collapse to the same
  // value (common when the data's max year is less than the app's init year),
  // open a 1-year window anchored at the data maximum so the scrubber is
  // immediately useful rather than frozen at a zero-width position.
  if (changed) {
    _endYear   = Math.min(_endYear,   _maxYear);
    _startYear = Math.max(_startYear, _minYear);
    if (_startYear >= _endYear) {
      _endYear   = _maxYear;
      _startYear = Math.max(_minYear, _maxYear - 1);
    }
    _render();
    _onRange?.(_startYear, _endYear, _activeMonths);
  }
}

/** Returns true if the given date string (YYYY-MM-DD) passes the current range. */
export function datePassesTimeline(dateStr) {
  if (!dateStr) return true;  // undated features always pass
  const d = new Date(dateStr);
  const y = d.getFullYear();
  if (y < _startYear || y > _endYear) return false;
  if (_activeMonths.size > 0 && !_activeMonths.has(d.getMonth())) return false;
  return true;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function _render() {
  const container = document.getElementById('timeline-track');
  if (!container) return;

  const pct = v => ((v - _minYear) / Math.max(_maxYear - _minYear, 1)) * 100;

  // Fill bar
  const fill = container.querySelector('.timeline-fill');
  if (fill) {
    fill.style.left  = `${pct(_startYear)}%`;
    fill.style.width = `${pct(_endYear) - pct(_startYear)}%`;
  }

  // Handle positions
  const hStart = container.querySelector('[data-handle="start"]');
  const hEnd   = container.querySelector('[data-handle="end"]');
  if (hStart) hStart.style.left = `${pct(_startYear)}%`;
  if (hEnd)   hEnd.style.left   = `${pct(_endYear)}%`;

  // Label
  const label = document.getElementById('timeline-label');
  if (label) {
    label.textContent = _startYear === _endYear
      ? String(_startYear)
      : `${_startYear} – ${_endYear}`;
  }

  // Tick marks — rebuild whenever the year range changes
  const ticks = container.querySelector('.timeline-ticks');
  if (ticks) {
    const rangeKey = `${_minYear}-${_maxYear}`;
    if (ticks.dataset.rangeKey !== rangeKey) {
      ticks.innerHTML = '';
      _buildTicks(ticks);
      ticks.dataset.rangeKey = rangeKey;
    }
  }
}

function _buildTicks(ticks) {
  const span = _maxYear - _minYear;
  // Show ticks every 1, 2, or 5 years depending on span
  const step = span <= 10 ? 1 : span <= 20 ? 2 : 5;
  const start = Math.ceil(_minYear / step) * step;
  for (let y = start; y <= _maxYear; y += step) {
    const tick = document.createElement('span');
    tick.className = 'timeline-tick';
    tick.style.left = `${((y - _minYear) / Math.max(_maxYear - _minYear, 1)) * 100}%`;
    tick.dataset.year = y;
    ticks.appendChild(tick);
  }
}

// ── Drag interaction ──────────────────────────────────────────────────────────

export function mountTimelineDrag() {
  const container = document.getElementById('timeline-track');
  if (!container) return;

  let dragging = null;

  function toYear(clientX) {
    const rect = container.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(_minYear + frac * (_maxYear - _minYear));
  }

  container.addEventListener('pointerdown', e => {
    const handle = e.target.closest('[data-handle]');
    if (!handle) return;
    dragging = handle.dataset.handle;
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  container.addEventListener('pointermove', e => {
    if (!dragging) return;
    const y = toYear(e.clientX);
    if (dragging === 'start') {
      _startYear = Math.min(y, _endYear);
    } else {
      _endYear = Math.max(y, _startYear);
    }
    _render();
    _applyTemporalLayers();
    _updateCaption();
    _onRange?.(_startYear, _endYear, _activeMonths);
  });

  container.addEventListener('pointerup', () => { dragging = null; });
  container.addEventListener('pointercancel', () => { dragging = null; });

  // Keyboard support on handles
  container.addEventListener('keydown', e => {
    const handle = e.target.closest('[data-handle]');
    if (!handle) return;
    const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!delta) return;
    if (handle.dataset.handle === 'start') {
      _startYear = Math.max(_minYear, Math.min(_startYear + delta, _endYear));
    } else {
      _endYear = Math.min(_maxYear, Math.max(_endYear + delta, _startYear));
    }
    _render();
    _applyTemporalLayers();
    _updateCaption();
    _onRange?.(_startYear, _endYear, _activeMonths);
    e.preventDefault();
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
