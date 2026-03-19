/**
 * history.js — Historical snapshot retrieval and trend chart rendering.
 *
 * Snapshots are pre-aggregated JSON files stored server-side under ./snapshots/.
 * This module fetches only the years needed for the current view and never
 * caches internally — callers are responsible for nullifying references to
 * allow garbage collection.
 *
 * No DOM mutations outside the container element passed to renderTrendChart.
 * No network calls beyond /api/snapshots.
 */

// ── Snapshot index ────────────────────────────────────────────────────────────

/**
 * Fetch the list of available snapshot files from the server.
 *
 * @returns {Promise<string[]>} Array of filenames, e.g. ["inat-2024.json", ...]
 */
export async function fetchSnapshotIndex() {
  const res = await fetch('/api/snapshots');
  if (!res.ok) throw new Error(`Snapshot index error: ${res.status}`);
  const data = await res.json();
  return data.files ?? [];
}

/**
 * Fetch and parse a single snapshot file.
 * Returns null if the file does not exist (404) rather than throwing.
 *
 * @param {'inat'|'gbif'|'noaa'|'nass'|'cdl'} source
 * @param {number} year
 * @returns {Promise<object|null>}
 */
export async function fetchSnapshot(source, year) {
  const res = await fetch(`/api/snapshots/${source}-${year}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Snapshot fetch error: ${res.status}`);
  return res.json();
}

// ── Available years helper ────────────────────────────────────────────────────

/**
 * Return sorted ascending list of years available for a given source,
 * derived from the snapshot index.
 *
 * @param {string[]} files  Result of fetchSnapshotIndex()
 * @param {'inat'|'gbif'|'noaa'|'nass'|'cdl'} source
 * @returns {number[]}
 */
export function availableYears(files, source) {
  return files
    .filter(f => f.startsWith(`${source}-`) && f.endsWith('.json'))
    .map(f => parseInt(f.slice(source.length + 1, -5), 10))
    .filter(y => !isNaN(y))
    .sort((a, b) => a - b);
}

// ── SVG bar chart ─────────────────────────────────────────────────────────────

const BAR_COLOR       = '#6ee7b7';  // emerald-300 — matches the climate ribbon accent
const BAR_COLOR_HOVER = '#34d399';
const CHART_H         = 120;
const LABEL_H         = 18;   // px reserved below bars for year labels
const VALUE_H         = 14;   // px reserved above bars for value labels
const PAD_L           = 4;
const PAD_R           = 4;

/**
 * Render a minimal accessible SVG bar chart into a DOM container.
 *
 * Existing chart content in the container is replaced on each call.
 * The SVG is responsive (100% width) and sets a fixed viewBox height.
 *
 * @param {string}   containerId  ID of the DOM element to render into
 * @param {{year: number, value: number}[]} snapshots  Data points, sorted by year
 * @param {string}   label        Human-readable description of the value axis
 */
export function renderTrendChart(containerId, snapshots, label) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!snapshots.length) {
    container.textContent = 'No data.';
    return;
  }

  const n      = snapshots.length;
  const maxVal = Math.max(...snapshots.map(d => d.value), 1);
  const totalH = CHART_H + LABEL_H + VALUE_H;
  const barAreaH = CHART_H - VALUE_H;

  // Build SVG as a string to avoid repeated DOM operations
  const svgParts = [
    `<svg role="img" aria-label="${_escAttr(label + ': ' + snapshots.map(d => `${d.year}: ${_fmt(d.value)}`).join(', '))}"`,
    ` xmlns="http://www.w3.org/2000/svg"`,
    ` viewBox="0 0 200 ${totalH}"`,
    ` preserveAspectRatio="none"`,
    ` style="width:100%;height:${totalH}px;display:block;">`,
    `<title>${_escText(label)}</title>`,
  ];

  const slotW = (200 - PAD_L - PAD_R) / n;
  const barW  = Math.max(2, slotW * 0.65);
  const gap   = (slotW - barW) / 2;

  for (let i = 0; i < n; i++) {
    const { year, value } = snapshots[i];
    const barH  = Math.max(1, (value / maxVal) * barAreaH);
    const x     = PAD_L + i * slotW + gap;
    const y     = VALUE_H + (barAreaH - barH);
    const cx    = PAD_L + i * slotW + slotW / 2;

    // Bar
    svgParts.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}"`,
      ` width="${barW.toFixed(1)}" height="${barH.toFixed(1)}"`,
      ` fill="${BAR_COLOR}" rx="1"`,
      ` aria-hidden="true"/>`,
    );
    // Value label above bar
    svgParts.push(
      `<text x="${cx.toFixed(1)}" y="${(y - 2).toFixed(1)}"`,
      ` text-anchor="middle" font-size="7" fill="#d1fae5" aria-hidden="true">`,
      _escText(_fmt(value)),
      `</text>`,
    );
    // Year label below bar
    svgParts.push(
      `<text x="${cx.toFixed(1)}" y="${(CHART_H + LABEL_H - 2).toFixed(1)}"`,
      ` text-anchor="middle" font-size="7" fill="#9ca3af" aria-hidden="true">`,
      _escText(String(year)),
      `</text>`,
    );
  }

  svgParts.push('</svg>');
  container.innerHTML = svgParts.join('');
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function _fmt(v) {
  if (v == null) return '—';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v));
}

function _escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function _escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
