/**
 * timeline.js — Year range scrubber for filtering sighting observations.
 *
 * A horizontal dual-handle range slider mounted at the bottom of the map.
 * Dragging the handles filters the in-memory sighting features to only those
 * whose `date` property falls within the selected year range — no new API calls.
 *
 * The scrubber operates on the post-filter feature store via a callback
 * provided at init time. It layers on top of (but is independent from)
 * the active filter chips in filters.js.
 */

/** @type {function(startYear:number, endYear:number): void} */
let _onRange = null;

let _minYear   = 2000;
let _maxYear   = new Date().getFullYear();
let _startYear = _maxYear - 1;
let _endYear   = _maxYear;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the timeline scrubber.
 *
 * @param {function(startYear:number, endYear:number): void} onRange
 *   Called whenever the selected range changes with (startYear, endYear).
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
  // Expand the range bounds but keep the user's current handles locked
  // to "last 1 year" unless they've already been dragged.
  if (changed) {
    // Preserve a "last year" default if handles are still at init positions
    if (_startYear === _endYear - 1 && _endYear === _maxYear) {
      // handles already reflect "last 1 year" — just update min bound
    } else if (_startYear <= _minYear && _endYear >= _maxYear) {
      // handles were at full extent — reset to last 1 year
      _startYear = _maxYear - 1;
      _endYear   = _maxYear;
    }
    // Clamp handles to new valid range
    _startYear = Math.max(_minYear, _startYear);
    _endYear   = Math.min(_maxYear, _endYear);
    _render();
    _onRange?.(_startYear, _endYear);
  }
}

/** Returns true if the given date string (YYYY-MM-DD) passes the current range. */
export function datePassesTimeline(dateStr) {
  if (!dateStr) return true;  // undated features always pass
  const y = new Date(dateStr).getFullYear();
  return y >= _startYear && y <= _endYear;
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
    _onRange?.(_startYear, _endYear);
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
    _onRange?.(_startYear, _endYear);
    e.preventDefault();
  });
}
