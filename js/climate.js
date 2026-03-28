/**
 * climate.js — NOAA climate data integration for pollinator phenology context.
 *
 * Fetches three NOAA datasets:
 *   A. 1991–2020 Daily Climate Normals (temperature + GDD) — no token required
 *   B. 1991–2020 Frost Date Normals (spring/fall probabilities) — no token required
 *   C. Current-year GHCND daily summaries (live TMAX/TMIN) — token required, proxied
 *
 * CORS: Endpoints A and B are fetched directly (NCEI Access Data Service is CORS-open).
 *       Endpoint C is proxied through /api/noaa/ghcnd (token stays server-side).
 *
 * Temperature values: NOAA normals and GHCND both return tenths of °F — divide by 10.
 * Missing sentinel: −9999 → treated as null, excluded from all calculations.
 *
 * GDD base: 50°F, no upper cap (standard for most insect phenology tracking).
 *
 * Phenological threshold citations:
 *   Forrest & Thomson (2011), Ecology Letters — bee emergence timing
 *   Rao & Lomon (2010), Journal of Economic Entomology — bee activity phenology
 *   Journey North monarch migration data (journeynorth.org)
 */

import { cacheGet, cacheSet } from './cache.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Green Bay Austin Straubel International Airport — verified as the highest-quality
// (S-flag = complete) station in the Green Bay bounding box (44.45–44.65°N, 87.85–88.15°W)
// via the NCEI station-query on 2025-03.
const STATION_ID     = 'USW00014898';
const NCEI_BASE      = 'https://www.ncei.noaa.gov/access/services/data/v1';
const NORMALS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days (normals recomputed ~decadally)
const GHCND_TTL_MS   = 12 * 60 * 60 * 1000;         // 12 hours

/** GDD base-50 phenological thresholds for Green Bay's principal pollinators.
 *  Sources: Forrest & Thomson (2011); Rao & Lomon (2010); journeynorth.org */
const GDD_THRESHOLDS = [
  { gdd: 200,  label: '🐝 Mason & mining bee emergence' },
  { gdd: 400,  label: '🐝 Bumble bee queens active'     },
  { gdd: 750,  label: '🌸 Peak native bee season'       },
  { gdd: 1200, label: '🦋 Monarch peak migration'       },
];

// ── Module state ──────────────────────────────────────────────────────────────

let _climateState = null;

/** 'live' | 'bundled' | null — set after fetchNoaaNormals resolves */
export let normalsSource = null;

/** Returns the most recently computed climate state object, or null if not yet loaded. */
export function getClimateState() { return _climateState; }

/**
 * Returns a { value, label } pair for display in the intel bar climate stat.
 * value: formatted GDD string ("247 GDD") or "—"
 * label: emoji + phenological phase name ("🌡 Mason bee emergence")
 */
export function getGddIntelStat() {
  if (!_climateState?.current) return { value: '—', label: '🌡 Season phase' };
  const gdd = Math.round(_climateState.current.accumulatedGDD);
  const phases = [
    { min: 1200, label: '🌡 Monarch migration'    },
    { min: 750,  label: '🌡 Peak native season'    },
    { min: 400,  label: '🌡 Bumble queens active'  },
    { min: 200,  label: '🌡 Mason bee emergence'   },
    { min: 0,    label: '🌡 Pre-season'            },
  ];
  const label = phases.find(p => gdd >= p.min)?.label ?? '🌡 Pre-season';
  return { value: `${gdd.toLocaleString()} GDD`, label };
}

// ── NOAA fetch helpers ────────────────────────────────────────────────────────

/**
 * Fetches bundled 1991-2020 daily normals from the local server fallback.
 * Used when the NOAA NCEI API returns empty data due to federal service disruption.
 * @returns {Promise<Array<{doy,date,tmax,tmin,tavg,gddTb50,gddBase50}>|null>}
 */
async function fetchBundledNormals() {
  try {
    const res = await fetch('/api/climate-normals');
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.records) && json.records.length ? json.records : null;
  } catch (e) {
    console.warn('[climate] bundled normals fetch error:', e.message);
    return null;
  }
}

/**
 * Fetches NOAA 1991–2020 Daily Climate Normals for the Green Bay station.
 * Tries the NCEI live API first; falls back to bundled data if the API
 * returns empty results (NOAA public data access disrupted 2025).
 * Cached 30 days in the browser Cache API.
 *
 * @returns {Promise<Array<{doy,date,tmax,tmin,tavg,gddTb50,gddBase50}>|null>}
 */
export async function fetchNoaaNormals() {
  const cacheKey = `noaa-normals-${STATION_ID}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    // Validate cached data actually has temperature values — guard against stale null entries
    const hasValues = Array.isArray(cached?.records ?? cached) &&
      (cached?.records ?? cached).some(r => r.tmax !== null);
    if (hasValues) {
      normalsSource = cached.source ?? 'bundled';
      return cached.records ?? cached;
    }
    // Stale/invalid cache — fall through to re-fetch
  }

  const params = new URLSearchParams({
    dataset:   'normals-daily-1991-2020',
    stations:  STATION_ID,
    startDate: '2010-01-01',
    endDate:   '2010-12-31',
    format:    'json',
    units:     'standard',
    dataTypes: 'dly-tmax-normal,dly-tmin-normal,dly-tavg-normal,dly-grdd-tb5086,dly-grdd-base50',
  });

  let parsed = null;
  try {
    const res = await fetch(`${NCEI_BASE}?${params}`);
    if (res.ok) {
      const raw = await res.json();
      if (Array.isArray(raw) && raw.length > 0) {
        const attempt = parseNormalsRows(raw);
        // Check that we actually got temperature data (not just empty station rows)
        const hasValues = attempt.some(r => r.tmax !== null);
        if (hasValues) {
          parsed = attempt;
          normalsSource = 'live';
          const jul15 = parsed.find(r => r.doy === 196);
          if (jul15) console.debug('[climate] normals spot-check Jul 15:', jul15);
        } else {
          console.warn('[climate] NCEI returned rows with no temperature values — using bundled fallback');
        }
      }
    } else {
      console.warn('[climate] normals HTTP', res.status, '— using bundled fallback');
    }
  } catch (e) {
    console.warn('[climate] normals fetch error:', e.message, '— using bundled fallback');
  }

  if (!parsed) {
    parsed = await fetchBundledNormals();
    if (parsed) normalsSource = 'bundled';
  }

  if (parsed) await cacheSet(cacheKey, { records: parsed, source: normalsSource }, NORMALS_TTL_MS);
  return parsed;
}

/**
 * Fetches NOAA 1991–2020 Frost Date Normals (annual/seasonal dataset).
 * No auth token needed. Cached 30 days.
 *
 * @returns {Promise<{springFrost32,springFrost28,fallFrost32,fallFrost28}|null>}
 */
export async function fetchFrostNormals() {
  const cacheKey = `noaa-frost-${STATION_ID}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    dataset:   'normals-annualseasonal-1991-2020',
    stations:  STATION_ID,
    format:    'json',
    dataTypes: 'ann-tmin-prbfst32,ann-tmin-prbfst28,ann-tmin-prblst32,ann-tmin-prblst28',
  });

  try {
    const res = await fetch(`${NCEI_BASE}?${params}`);
    if (!res.ok) { console.warn('[climate] frost normals HTTP', res.status); return null; }
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const parsed = parseFrostRows(raw);
    await cacheSet(cacheKey, parsed, NORMALS_TTL_MS);
    return parsed;
  } catch (e) {
    console.warn('[climate] frost normals fetch error:', e.message);
    return null;
  }
}

/**
 * Fetches observed daily temps for a given year from the IEM-sourced archive.
 * @returns {Promise<Array<{doy,date,tmax,tmin,tavg,gddBase50}>|null>}
 */
async function fetchObservedYear(year) {
  try {
    const res = await fetch(`/api/observed-temps/${year}`);
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.records) && json.records.length ? json.records : null;
  } catch (e) {
    return null;
  }
}

/**
 * Fetches current-year observed TMAX/TMIN from GHCND via the local proxy.
 * Requires a NOAA CDO token configured in serve.js (see noaa-token.txt).
 * Returns null gracefully if the token is absent or the proxy errors.
 * Cached 12 hours.
 *
 * @returns {Promise<Array<{DATE,TMAX,TMIN}>|null>}
 */
export async function fetchGhcndCurrent() {
  const year     = new Date().getFullYear();
  const cacheKey = `noaa-ghcnd-current-${STATION_ID}-${year}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const startDate = `${year}-01-01`;
  const endDate   = yesterday.toISOString().slice(0, 10);

  try {
    const res  = await fetch(`/api/noaa/ghcnd?startDate=${startDate}&endDate=${endDate}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.available === false) return null;  // no token configured
    if (!Array.isArray(data) || data.length === 0) return null;
    await cacheSet(cacheKey, data, GHCND_TTL_MS);
    return data;
  } catch (e) {
    console.warn('[climate] GHCND fetch error:', e.message);
    return null;
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse raw NOAA daily-normals array into sorted day objects.
 * NOAA returns temperatures in tenths of °F (703 = 70.3 °F) — divide by 10.
 * Missing sentinel −9999 becomes null.
 */
function parseNormalsRows(rows) {
  rows.sort((a, b) => (a.DATE ?? '').localeCompare(b.DATE ?? ''));
  return rows.map(row => {
    const deciNum = (key) => {
      const v = Number(row[key]);
      return (isNaN(v) || v <= -9998) ? null : v / 10;
    };
    const date = new Date(`${row.DATE}T00:00:00`);
    const doy  = Math.round((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    return {
      doy,
      date:      row.DATE ?? '',
      tmax:      deciNum('dly-tmax-normal'),
      tmin:      deciNum('dly-tmin-normal'),
      tavg:      deciNum('dly-tavg-normal'),
      gddTb50:   deciNum('dly-grdd-tb5086'),
      gddBase50: deciNum('dly-grdd-base50'),
    };
  }).filter(r => r.doy >= 1 && r.doy <= 366);
}

/**
 * Parse frost-probability normals rows.
 *
 * The NCEI annual/seasonal dataset returns one row per day-of-year in the
 * seasonal window (jan–jun for spring, aug–dec for fall), with the
 * field value being the probability (0–100 or 0–1) that the frost event
 * has occurred by that date (cumulative).
 *
 * Returns { springFrost32, springFrost28, fallFrost32, fallFrost28 } where
 * each is { p10, p50, p90 } day-of-year integers, or null if unavailable.
 */
function parseFrostRows(rows) {
  const series = {
    'ann-tmin-prblst32': [],
    'ann-tmin-prblst28': [],
    'ann-tmin-prbfst32': [],
    'ann-tmin-prbfst28': [],
  };

  for (const row of rows) {
    const doy = parseDateToDoy(row.DATE);
    if (!doy) continue;
    for (const key of Object.keys(series)) {
      const raw = row[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const v = Number(raw);
      if (!isNaN(v) && v > -9998) series[key].push({ doy, prob: v });
    }
  }

  for (const key of Object.keys(series)) series[key].sort((a, b) => a.doy - b.doy);

  return {
    springFrost32: extractProbThresholds(series['ann-tmin-prblst32']),
    springFrost28: extractProbThresholds(series['ann-tmin-prblst28']),
    fallFrost32:   extractProbThresholds(series['ann-tmin-prbfst32']),
    fallFrost28:   extractProbThresholds(series['ann-tmin-prbfst28']),
  };
}

/** Convert a NOAA DATE string to 1-based day-of-year. Handles YYYY-MM-DD, MM-DD, DDD. */
function parseDateToDoy(dateStr) {
  if (!dateStr) return null;
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = new Date(`${dateStr}T00:00:00`);
    return Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  }
  const md = dateStr.match(/^(\d{2})-(\d{2})$/);
  if (md) {
    const d = new Date(`2010-${dateStr}T00:00:00`);
    return Math.round((d - new Date(2010, 0, 0)) / 86400000);
  }
  const ddd = dateStr.match(/^(\d{1,3})$/);
  if (ddd) return parseInt(ddd[1], 10);
  return null;
}

/**
 * Find day-of-year where cumulative probability crosses 10%, 50%, 90%.
 * Probability values may be 0–100 (percent) or 0–1 (fraction) — normalised automatically.
 */
function extractProbThresholds(series) {
  if (!series.length) return null;
  const maxVal = Math.max(...series.map(s => s.prob));
  const scale  = maxVal > 1.5 ? 100 : 1;   // normalise to 0–1

  const findCrossing = (target) => {
    for (let i = 0; i < series.length - 1; i++) {
      const p0 = series[i].prob / scale;
      const p1 = series[i + 1].prob / scale;
      if (p0 <= target && p1 >= target) {
        const t = (target - p0) / (p1 - p0);
        return Math.round(series[i].doy + t * (series[i + 1].doy - series[i].doy));
      }
    }
    return null;
  };

  return { p10: findCrossing(0.10), p50: findCrossing(0.50), p90: findCrossing(0.90) };
}

// ── GDD computation ───────────────────────────────────────────────────────────

/** Compute GDD base 50°F from raw GHCND TMAX/TMIN (tenths of °F). Returns 0 for missing. */
function computeDayGdd(tmaxRaw, tminRaw, base = 50) {
  if (tmaxRaw <= -9998 || tminRaw <= -9998) return 0;
  return Math.max(0, (tmaxRaw / 10 + tminRaw / 10) / 2 - base);
}

/**
 * Accumulate GDD from Jan 1 through the last available GHCND date.
 * @param {object[]} ghcndRows — [{ DATE: "YYYY-MM-DD", TMAX: "NNN", TMIN: "NNN" }, ...]
 * @returns {{ accumulatedGDD: number, latestDate: string|null }}
 */
export function computeCurrentGdd(ghcndRows) {
  if (!ghcndRows?.length) return { accumulatedGDD: 0, latestDate: null };
  let total = 0, latestDate = null;
  for (const row of ghcndRows) {
    const tmax = Number(row.TMAX), tmin = Number(row.TMIN);
    if (!isNaN(tmax) && !isNaN(tmin)) {
      total += computeDayGdd(tmax, tmin);
      latestDate = row.DATE;
    }
  }
  return { accumulatedGDD: total, latestDate };
}

/**
 * Sum normal GDD base-50 values from DOY 1 through throughDoy (inclusive).
 * @param {object[]} normalsRows
 * @param {number}   throughDoy
 * @returns {number}
 */
export function computeNormalGdd(normalsRows, throughDoy) {
  if (!normalsRows?.length) return 0;
  return normalsRows
    .filter(r => r.doy <= throughDoy && r.gddBase50 !== null)
    .reduce((sum, r) => sum + r.gddBase50, 0);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Convert a 1-based day-of-year to a short readable label ("May 10"). Uses 2010 (non-leap). */
export function doyToLabel(doy) {
  const d = new Date(2010, 0, doy);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Current day of year (1-based). */
function todayDoy() {
  const now = new Date();
  return Math.round((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
}

// ── Panel initialization ──────────────────────────────────────────────────────

let _ribbonBtn = null;

/**
 * Fetches all NOAA climate data, populates _climateState, and wires the
 * climate ribbon modal. The panel-climate-inner DOM element is no longer used
 * (climate info is now surfaced via the intel bar stat), but this function
 * must still be called to load the data for getGddIntelStat() and alerts.
 * Called once from app.js after map.on('load').
 */
export async function initClimatePanel() {
  const currentYear = new Date().getFullYear();
  // Fetch normals + frost + GHCND in parallel, then observed years non-blocking
  const [normals, frost, ghcnd] = await Promise.all([
    fetchNoaaNormals(),
    fetchFrostNormals(),
    fetchGhcndCurrent(),
  ]);

  const doy       = todayDoy();
  const current   = ghcnd ? computeCurrentGdd(ghcnd) : null;
  const normalGdd = normals ? computeNormalGdd(normals, doy) : null;
  const pctDev    = (current && normalGdd && normalGdd > 0)
    ? ((current.accumulatedGDD - normalGdd) / normalGdd) * 100
    : null;

  _climateState = { normals, frost, ghcnd, current, normalGdd, pctDeviation: pctDev, doy, observedYears: {} };

  // Wire the modal close button (the modal is still in the HTML for the ribbon chart)
  const modal    = document.getElementById('modal-climate');
  const closeBtn = modal?.querySelector('.modal-close');
  closeBtn?.addEventListener('click', closeClimateModal);
  modal?.addEventListener('click', e => { if (e.target === modal) closeClimateModal(); });

  // Fetch IEM observed years asynchronously (non-blocking — enhances ribbon when ready)
  const obsYears = [];
  for (let y = 2021; y <= currentYear; y++) obsYears.push(y);
  const obsResults = await Promise.all(obsYears.map(y => fetchObservedYear(y)));
  const observedYears = {};
  obsYears.forEach((y, i) => { if (obsResults[i]) observedYears[y] = obsResults[i]; });
  _climateState.observedYears = observedYears;

  // Prefer IEM observed data for current-year GDD when available — more reliable than GHCND
  // (NOAA CDO/GHCND may return real rows with 0 GDD if all days are below 50°F, hiding IEM data)
  const currentYearObs = observedYears[currentYear];
  if (currentYearObs) {
    const iemGdd = currentYearObs.reduce((sum, r) => sum + (r.gddBase50 ?? 0), 0);
    const lastRec = currentYearObs[currentYearObs.length - 1];
    _climateState.current = { accumulatedGDD: iemGdd, latestDate: lastRec?.date ?? null, source: 'iem' };
    const normalGddUpd = normals ? computeNormalGdd(normals, doy) : null;
    _climateState.normalGdd = normalGddUpd;
    _climateState.pctDeviation = (normalGddUpd && normalGddUpd > 0)
      ? ((iemGdd - normalGddUpd) / normalGddUpd) * 100
      : null;
  } else if (!_climateState.current?.latestDate) {
    // IEM also unavailable — current stays as GHCND result (may be 0 or null)
  }
}

// ── Panel DOM rendering ───────────────────────────────────────────────────────

function renderClimatePanelInner(container, state) {
  const { frost, current, normalGdd, pctDeviation } = state;

  // ── GDD progress section ──────────────────────────────────────────────────
  let gddHtml = '';
  if (current !== null) {
    const gddVal     = Math.round(current.accumulatedGDD);
    const barPct     = normalGdd > 0 ? Math.min(100, Math.round(current.accumulatedGDD / normalGdd * 100)) : null;
    const aboveNorm  = barPct !== null && barPct >= 100;
    const barColor   = aboveNorm ? '#34d399' : '#f59e0b';
    const pctLabel   = pctDeviation !== null
      ? ` <span class="gdd-pct-deviation ${aboveNorm ? 'gdd-above' : 'gdd-below'}">${pctDeviation >= 0 ? '+' : ''}${Math.round(pctDeviation)}% vs normal</span>`
      : '';

    gddHtml = `
      <div class="climate-stat">
        <span class="climate-stat-label">🌱 GDD accumulated (base 50°F):</span>
        <span class="climate-stat-value">${gddVal.toLocaleString()} GDD${pctLabel}</span>
      </div>`;

    if (barPct !== null) {
      gddHtml += `
      <div class="climate-progress-wrap">
        <div class="climate-progress-bar"
             role="progressbar"
             aria-valuenow="${barPct}"
             aria-valuemin="0"
             aria-valuemax="100"
             aria-label="GDD accumulation: ${barPct}% of seasonal normal">
          <div class="climate-progress-fill" style="width:${barPct}%;background:${barColor}"></div>
        </div>
        <span class="climate-progress-label">${barPct}% of normal</span>
      </div>`;
    }
  } else {
    gddHtml = `<p class="climate-note">Live GDD unavailable — add a NOAA CDO token to <code>api-keys.txt</code> (NOAA_CDO_TOKEN=your_token).</p>`;
  }

  // ── Frost dates section ───────────────────────────────────────────────────
  let frostHtml = '';
  const ls32 = frost?.springFrost32, ff32 = frost?.fallFrost32;
  const ls28 = frost?.springFrost28, ff28 = frost?.fallFrost28;
  if (ls32?.p50 && ff32?.p50) {
    const frostFreeStr  = `~${ff32.p50 - ls32.p50} days`;
    const lastFrostStr  = `~${doyToLabel(ls32.p50)}${ls28?.p50 ? ` · Hard: ~${doyToLabel(ls28.p50)}` : ''}`;
    const firstFrostStr = `~${doyToLabel(ff32.p50)}${ff28?.p50 ? ` · Hard: ~${doyToLabel(ff28.p50)}` : ''}`;
    frostHtml = `
      <div class="climate-frost">
        <div class="climate-stat">
          <span class="climate-stat-label">🌿 Frost-free season:</span>
          <span class="climate-stat-value">${frostFreeStr}</span>
        </div>
        <div class="climate-frost-detail">Last spring frost (50%): ${lastFrostStr}</div>
        <div class="climate-frost-detail">First fall frost (50%): ${firstFrostStr}</div>
      </div>`;
  } else if (frost === null && state.normals === null) {
    frostHtml = `<p class="climate-note">Frost date data unavailable.</p>`;
  }

  container.innerHTML = `
    ${gddHtml}
    ${frostHtml}
    <div class="climate-ribbon-row">
      <button id="btn-climate-ribbon" class="climate-ribbon-btn">📊 View Climate Ribbon</button>
    </div>
  `;
}

// ── Climate Ribbon modal ──────────────────────────────────────────────────────

export function openClimateRibbon(state) {
  const modal = document.getElementById('modal-climate');
  const body  = document.getElementById('modal-climate-body');
  if (!modal || !body) return;

  body.innerHTML = '';

  // Disruption notice when using bundled fallback data
  if (normalsSource === 'bundled' || (!state?.normals?.length && normalsSource !== 'live')) {
    const notice = document.createElement('div');
    notice.className = 'climate-disruption-notice';
    notice.innerHTML = `
      <strong>⚠ NOAA public climate data access disrupted</strong>
      <p>The NOAA National Centers for Environmental Information (NCEI) API that Bay Hive uses for 
      1991–2020 temperature normals stopped returning data following federal agency staffing and 
      budget cuts in 2025. The climate ribbon below is drawn from a pre-disruption archived copy 
      of those normals — the underlying science is the same, but it cannot be updated until 
      public access is restored.</p>
      <p>Live current-year GDD readings (via NOAA CDO) may also be affected depending on your token 
      status. Observed daily temperatures for 2021–2026 are sourced from the 
      <a href="https://mesonet.agron.iastate.edu/" target="_blank" rel="noopener">Iowa Environmental Mesonet (IEM)</a> 
      at Iowa State University — an independent archive not affected by federal disruption. 
      <a href="https://www.weather.gov/gbr/" target="_blank" rel="noopener">NOAA Green Bay Forecast Office</a> 
      and <a href="https://www.ncei.noaa.gov/" target="_blank" rel="noopener">NCEI</a> remain the 
      authoritative sources if access is restored. To advocate for open government climate data, 
      contact your representatives or support the 
      <a href="https://www.ametsoc.org/" target="_blank" rel="noopener">American Meteorological Society</a> 
      and <a href="https://www.esipfed.org/" target="_blank" rel="noopener">ESIP Federation</a>.</p>`;
    body.appendChild(notice);
  }

  if (state?.normals?.length) {
    body.appendChild(buildRibbonSvg(state));
  } else {
    const empty = document.createElement('p');
    empty.className = 'climate-ribbon-empty';
    empty.textContent = 'Temperature normals could not be loaded — neither the NOAA API nor the local fallback returned data.';
    body.appendChild(empty);
  }

  modal.removeAttribute('hidden');

  // Trap focus per WCAG 2.2 SC 2.1.2
  modal.addEventListener('keydown', _trapFocus);
  modal.querySelector('.modal-close')?.focus();
}

function _trapFocus(e) {
  const modal     = document.getElementById('modal-climate');
  const focusable = Array.from(modal.querySelectorAll('button, [tabindex="0"]'));
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.key === 'Escape')  { closeClimateModal(); return; }
  if (e.key !== 'Tab')     return;
  if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
  else            { if (document.activeElement === last)  { e.preventDefault(); first?.focus(); } }
}

function closeClimateModal() {
  const modal = document.getElementById('modal-climate');
  modal?.setAttribute('hidden', '');
  modal?.removeEventListener('keydown', _trapFocus);
  _ribbonBtn?.focus();
}

// ── SVG ribbon chart ──────────────────────────────────────────────────────────

// Layout constants (viewBox units)
const W  = 800, H  = 280;
const ML = 50,  MR = 65, MT = 20, MB = 40;
const PW = W - ML - MR;
const PH = H - MT - MB;

/** Map day-of-year (1–366) → SVG X. */
const px = doy => ML + (doy - 1) / 365 * PW;

/** Map value on [vMin, vMax] → SVG Y (inverted: higher value = higher up). */
const pyScale = (v, vMin, vMax) => MT + PH * (1 - (v - vMin) / (vMax - vMin));

function buildRibbonSvg(state) {
  const { normals, frost, ghcnd, pctDeviation, doy, observedYears } = state;

  const svgNS = 'http://www.w3.org/2000/svg';

  const svgEl = (tag, attrs, text) => {
    const e = document.createElementNS(svgNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text != null) e.textContent = text;
    return e;
  };

  const svg = svgEl('svg', {
    viewBox:        `0 0 ${W} ${H}`,
    width:          '100%',
    height:         String(H),
    role:           'img',
    'aria-label':   buildAriaLabel(state),
  });
  svg.style.cssText = 'display:block;font-family:Segoe UI,system-ui,sans-serif';

  const add = e => svg.appendChild(e);

  // Temperature scale
  const TMIN = 0, TMAX = 95;
  const pyT  = v => pyScale(v, TMIN, TMAX);

  // GDD scale: find maximum cumulative normal GDD to set the right-axis ceiling
  let maxNormCum = 500;
  if (normals) {
    let s = 0;
    for (const r of normals) { if (r.gddBase50 !== null) { s += r.gddBase50; if (s > maxNormCum) maxNormCum = s; } }
  }
  const GDD_MAX = Math.ceil(maxNormCum / 500) * 500;
  const pyG     = v => pyScale(v, 0, GDD_MAX);

  // Background
  add(svgEl('rect', { x: ML, y: MT, width: PW, height: PH, fill: '#091610' }));

  // ── 1. Frost risk bands ───────────────────────────────────────────────────
  const springFrost = frost?.springFrost32;
  const fallFrost   = frost?.fallFrost32;

  if (springFrost?.p10 != null && springFrost?.p90 != null) {
    const x1 = px(springFrost.p10), x2 = px(springFrost.p90);
    add(svgEl('rect', { x: x1, y: MT, width: x2 - x1, height: PH, fill: 'rgba(96,165,250,0.16)' }));
    add(svgEl('text', { x: (x1 + x2) / 2, y: MT + 12, 'text-anchor': 'middle', fill: '#93c5fd', 'font-size': 9 }, 'Last frost risk'));
  }
  if (fallFrost?.p10 != null && fallFrost?.p90 != null) {
    const x1 = px(fallFrost.p10), x2 = px(fallFrost.p90);
    add(svgEl('rect', { x: x1, y: MT, width: x2 - x1, height: PH, fill: 'rgba(251,191,36,0.16)' }));
    add(svgEl('text', { x: (x1 + x2) / 2, y: MT + 12, 'text-anchor': 'middle', fill: '#fcd34d', 'font-size': 9 }, 'First frost risk'));
  }

  // ── 2. Temperature range fill (tmin–tmax band) ───────────────────────────
  if (normals) {
    const valid = normals.filter(r => r.tmax !== null && r.tmin !== null);
    if (valid.length > 1) {
      const top = valid.map((r, i) => `${i === 0 ? 'M' : 'L'}${px(r.doy).toFixed(1)},${pyT(r.tmax).toFixed(1)}`).join(' ');
      const bot = valid.slice().reverse().map(r => `L${px(r.doy).toFixed(1)},${pyT(r.tmin).toFixed(1)}`).join(' ');
      add(svgEl('path', { d: `${top} ${bot} Z`, fill: 'rgba(167,243,208,0.10)' }));
    }
  }

  // ── 3. Average temperature line ───────────────────────────────────────────
  if (normals) {
    const pts = normals.filter(r => r.tavg !== null);
    if (pts.length > 1) {
      const d = pts.map((r, i) => `${i === 0 ? 'M' : 'L'}${px(r.doy).toFixed(1)},${pyT(r.tavg).toFixed(1)}`).join(' ');
      add(svgEl('path', { d, fill: 'none', stroke: '#6ee7b7', 'stroke-width': 1.5 }));
    }
  }

  // ── 4a. GDD normal cumulative curve (dashed gray) ─────────────────────────
  if (normals) {
    let cum = 0;
    const pts = normals.map(r => {
      if (r.gddBase50 !== null) cum += r.gddBase50;
      return { doy: r.doy, gdd: cum };
    });
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.doy).toFixed(1)},${pyG(p.gdd).toFixed(1)}`).join(' ');
    add(svgEl('path', { d, fill: 'none', stroke: '#6b7280', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
  }

  // ── 4b. GDD live cumulative curve (solid, color-coded) ────────────────────
  if (ghcnd?.length) {
    let cum = 0;
    const pts = [];
    for (const row of ghcnd) {
      const tmax = Number(row.TMAX), tmin = Number(row.TMIN);
      if (!isNaN(tmax) && !isNaN(tmin)) {
        cum += computeDayGdd(tmax, tmin);
        const d    = new Date(`${row.DATE}T00:00:00`);
        const rDoy = Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
        pts.push({ doy: rDoy, gdd: cum });
      }
    }
    if (pts.length > 1) {
      const liveColor = (pctDeviation !== null && pctDeviation >= 0) ? '#34d399' : '#f59e0b';
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.doy).toFixed(1)},${pyG(p.gdd).toFixed(1)}`).join(' ');
      add(svgEl('path', { d, fill: 'none', stroke: liveColor, 'stroke-width': 2 }));
    }
  }

  // ── 5. Phenological threshold markers ─────────────────────────────────────
  if (normals) {
    let cum = 0;
    const cumByDoy = new Map();
    for (const r of normals) {
      if (r.gddBase50 !== null) cum += r.gddBase50;
      cumByDoy.set(r.doy, cum);
    }
    for (const thresh of GDD_THRESHOLDS) {
      let threshDoy = null;
      for (const [d, v] of cumByDoy) { if (v >= thresh.gdd) { threshDoy = d; break; } }
      if (!threshDoy) continue;
      const xPos = px(threshDoy);
      add(svgEl('line', { x1: xPos, y1: MT, x2: xPos, y2: MT + PH, stroke: 'rgba(167,243,208,0.35)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      // Accessible <text> element — rotated up the axis
      const lY = MT + PH - 4;
      add(svgEl('text', {
        x:              xPos - 2,
        y:              lY,
        transform:      `rotate(-90 ${xPos.toFixed(1)} ${lY})`,
        fill:           '#a7f3d0',
        'font-size':    8,
        'text-anchor':  'end',
      }, thresh.label));
    }
  }

  // ── 6. "Today" vertical marker ────────────────────────────────────────────
  const todayX     = px(doy);
  const todayShort = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  add(svgEl('line', { x1: todayX, y1: MT, x2: todayX, y2: MT + PH, stroke: '#f87171', 'stroke-width': 1.5 }));
  add(svgEl('text', { x: todayX + 3, y: MT + 9, fill: '#f87171', 'font-size': 9, 'font-weight': 'bold' }, todayShort));

  // ── 7. Observed year tavg lines (IEM archive, 2021–present) ──────────────
  // Muted palette — distinct but secondary to normals
  const obsColors = { 2021: '#a78bfa', 2022: '#f472b6', 2023: '#fb923c', 2024: '#38bdf8', 2025: '#facc15', 2026: '#86efac' };
  const obsEntries = Object.entries(observedYears || {}).sort((a, b) => a[0] - b[0]);
  for (const [yrStr, records] of obsEntries) {
    const yr    = parseInt(yrStr, 10);
    const color = obsColors[yr] ?? '#d1d5c8';
    const pts   = records.filter(r => r.tavg !== null && r.doy <= 365);
    if (pts.length < 10) continue;
    const d = pts.map((r, i) => `${i === 0 ? 'M' : 'L'}${px(r.doy).toFixed(1)},${pyT(r.tavg).toFixed(1)}`).join(' ');
    add(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1, opacity: '0.6' }));
    // Year label at last data point
    const last = pts[pts.length - 1];
    add(svgEl('text', { x: px(last.doy) + 3, y: pyT(last.tavg) + 3, fill: color, 'font-size': 8, opacity: '0.85' }, String(yr)));
  }

  // ── Axes ──────────────────────────────────────────────────────────────────
  // Axis box
  add(svgEl('rect', { x: ML, y: MT, width: PW, height: PH, fill: 'none', stroke: '#1e3a22', 'stroke-width': 1 }));

  // X-axis: month label + boundary grid line
  const months    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthDoys = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  for (let m = 0; m < 12; m++) {
    const midDoy = monthDoys[m] + (m < 11 ? (monthDoys[m + 1] - monthDoys[m]) / 2 : 16);
    add(svgEl('text', { x: px(midDoy), y: MT + PH + 14, 'text-anchor': 'middle', fill: '#9ca3af', 'font-size': 9 }, months[m]));
    const xB = px(monthDoys[m]);
    add(svgEl('line', { x1: xB, y1: MT, x2: xB, y2: MT + PH, stroke: 'rgba(156,163,175,0.07)', 'stroke-width': 1 }));
  }

  // Left Y-axis: temperature  (°F)
  for (let t = 0; t <= 90; t += 30) {
    const yT = pyT(t);
    add(svgEl('text', { x: ML - 4, y: yT + 4, 'text-anchor': 'end', fill: '#9ca3af', 'font-size': 9 }, `${t}°F`));
    add(svgEl('line', { x1: ML, y1: yT, x2: ML + PW, y2: yT, stroke: 'rgba(156,163,175,0.07)', 'stroke-width': 1 }));
  }

  // Right Y-axis: cumulative GDD
  const gddStep = GDD_MAX <= 2000 ? 500 : 1000;
  for (let g = 0; g <= GDD_MAX; g += gddStep) {
    const yG = pyG(g);
    add(svgEl('text', { x: ML + PW + 4, y: yG + 4, fill: '#6b7280', 'font-size': 9 }, String(g)));
  }
  // Rotated GDD axis label
  const gLX = W - 10, gLY = MT + PH / 2;
  add(svgEl('text', {
    x:             gLX,
    y:             gLY,
    transform:     `rotate(90 ${gLX} ${gLY})`,
    fill:          '#6b7280',
    'font-size':   8,
    'text-anchor': 'middle',
  }, 'Cum. GDD base 50°F'));

  return svg;
}

function buildAriaLabel(state) {
  const { frost, current, normalGdd, pctDeviation } = state;
  const parts = [
    'Climate ribbon chart for Green Bay, WI. 1991–2020 climate normals from NOAA station USW00014898 (Austin Straubel Airport).',
    'Temperature normal range spans approximately 0°F in January to 82°F in July.',
    'Green line shows 30-year average daily temperature. Gray filled band shows normal daily min-to-max range.',
    'Gray dashed curve shows cumulative normal GDD base 50°F. Colored solid curve shows current-year actual GDD.',
  ];
  if (frost?.springFrost32?.p50 && frost?.fallFrost32?.p50) {
    parts.push(`Frost-free growing season runs approximately ${doyToLabel(frost.springFrost32.p50)} to ${doyToLabel(frost.fallFrost32.p50)}.`);
  }
  if (current?.accumulatedGDD > 0) {
    const pct = pctDeviation !== null
      ? ` (${Math.round(Math.abs(pctDeviation))}% ${pctDeviation >= 0 ? 'above' : 'below'} the 30-year normal for this date)`
      : '';
    parts.push(`Current accumulated GDD is ${Math.round(current.accumulatedGDD)}${pct}.`);
  }
  parts.push('Vertical dashed lines mark phenological thresholds: 200 GDD mason and mining bee emergence; 400 GDD bumble bee queens active; 750 GDD peak native bee season; 1200 GDD monarch peak migration.');
  return parts.join(' ');
}
