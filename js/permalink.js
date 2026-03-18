/**
 * permalink.js — Hash-based URL permalink for the current map state.
 *
 * Encodes into the URL hash (#):
 *   - Map center (lng, lat) and zoom
 *   - Date range (from / to)
 *   - Active year range from timeline (startYear, endYear)
 *
 * Format: #z=<zoom>&c=<lng>,<lat>&d=<from>,<to>&y=<start>,<end>
 *
 * Usages:
 *   initPermalink(getState, getMap)   — call once after map loads
 *   applyPermalink()                  — call once on startup to restore state
 *   copyPermalink()                   — writes current URL to clipboard
 */

/** @returns {{ lon: number, lat: number, zoom: number }|null} Parsed hash state, or null. */
export function parsePermalink() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = Object.fromEntries(hash.split('&').map(p => p.split('=')));
  const z = parseFloat(params.z);
  const c = (params.c ?? '').split(',').map(Number);
  const d = (params.d ?? ',').split(',');
  const y = (params.y ?? ',').split(',').map(Number);
  if (!isFinite(z) || c.length < 2 || !isFinite(c[0]) || !isFinite(c[1])) return null;
  return {
    zoom:      z,
    center:    [c[0], c[1]],
    dateFrom:  d[0] || null,
    dateTo:    d[1] || null,
    startYear: isFinite(y[0]) ? y[0] : null,
    endYear:   isFinite(y[1]) ? y[1] : null,
  };
}

/**
 * Apply a parsed permalink object to the UI inputs.
 * Pass the MapLibre map instance — the camera will be set immediately.
 *
 * @param {object} state    Result of parsePermalink()
 * @param {object} map      MapLibre Map instance
 */
export function applyPermalinkState(state, map) {
  if (!state) return;
  if (state.center && isFinite(state.zoom)) {
    map.jumpTo({ center: state.center, zoom: state.zoom });
  }
  if (state.dateFrom) {
    const el = document.getElementById('date-from');
    if (el) el.value = state.dateFrom;
  }
  if (state.dateTo) {
    const el = document.getElementById('date-to');
    if (el) el.value = state.dateTo;
  }
}

/**
 * Build the current permalink string from live state.
 *
 * @param {object} map        MapLibre Map instance
 * @param {number} startYear  Timeline start year
 * @param {number} endYear    Timeline end year
 * @returns {string}          Full URL string
 */
function _buildUrl(map, startYear, endYear) {
  const c   = map.getCenter();
  const z   = map.getZoom().toFixed(2);
  const lon = c.lng.toFixed(5);
  const lat = c.lat.toFixed(5);
  const df  = document.getElementById('date-from')?.value ?? '';
  const dt  = document.getElementById('date-to')?.value   ?? '';
  const hash = `z=${z}&c=${lon},${lat}&d=${df},${dt}&y=${startYear},${endYear}`;
  return `${window.location.origin}${window.location.pathname}#${hash}`;
}

/** Module-level state getters — set by initPermalink. */
let _getMap       = null;
let _getYearRange = null;

/**
 * Initialise the permalink module.
 * Wires the "Copy link" button and registers a map 'moveend' listener to
 * keep the hash in sync with the viewport (debounced).
 *
 * @param {function(): object}           getMap        Returns MapLibre map instance.
 * @param {function(): [number, number]} getYearRange  Returns [startYear, endYear].
 */
export function initPermalink(getMap, getYearRange) {
  _getMap       = getMap;
  _getYearRange = getYearRange;

  // Keep hash updated as the user pans/zooms (debounced 300 ms)
  let _debTimer;
  const _sync = () => {
    clearTimeout(_debTimer);
    _debTimer = setTimeout(() => {
      const [sy, ey] = _getYearRange();
      window.location.replace(_buildUrl(_getMap(), sy, ey));
    }, 300);
  };
  _getMap().on('moveend', _sync);

  // "Copy link" button
  const btn = document.getElementById('btn-permalink');
  if (btn) {
    btn.addEventListener('click', () => copyPermalink());
  }
}

/**
 * Copy the current permalink to the clipboard and briefly update button label.
 */
export async function copyPermalink() {
  const [sy, ey] = _getYearRange?.() ?? [2009, new Date().getFullYear()];
  const url       = _buildUrl(_getMap(), sy, ey);
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById('btn-permalink');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }
  } catch {
    // Fallback: select a temporary input
    const inp = document.createElement('input');
    inp.value = url;
    inp.style.position = 'absolute';
    inp.style.opacity  = '0';
    document.body.appendChild(inp);
    inp.select();
    document.execCommand('copy');
    document.body.removeChild(inp);
  }
}
