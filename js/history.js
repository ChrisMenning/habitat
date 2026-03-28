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

// ── Monthly grouped bar chart ─────────────────────────────────────────────────

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const BAR_COLOR_POLL  = '#6ee7b7'; // emerald-300 — pollinators
const BAR_COLOR_PLANT = '#86efac'; // green-300   — native plants
const GROUPED_H       = 130;
const GROUPED_LABEL_H = 18;
const GROUPED_VALUE_H = 12;

/**
 * Render a grouped monthly bar chart (pollinators + native plants) into a container.
 * Falls back to a single-series chart when only one layer has data.
 *
 * @param {string} containerId
 * @param {{ pollinators: Object<string,number>, 'native-plants': Object<string,number> }} byLayerByMonth
 * @param {number} year
 */
export function renderMonthlyChart(containerId, byLayerByMonth, year) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!byLayerByMonth) {
    container.innerHTML = '<p class="layer-desc" style="color:#9ca3af;font-size:11px;">Monthly data not available — re-harvest this year to generate it.</p>';
    return;
  }

  const pollData  = byLayerByMonth.pollinators    ?? {};
  const plantData = byLayerByMonth['native-plants'] ?? {};

  const maxVal = Math.max(
    1,
    ...Object.values(pollData),
    ...Object.values(plantData),
  );

  const n = 12;
  const totalH   = GROUPED_H + GROUPED_LABEL_H + GROUPED_VALUE_H;
  const barAreaH = GROUPED_H - GROUPED_VALUE_H;
  const svgW     = 200;
  const slotW    = (svgW - PAD_L - PAD_R) / n;
  const groupGap = slotW * 0.12;
  const barW     = (slotW - groupGap * 2) / 2;

  const ariaLabel = `Monthly sightings ${year}: ` +
    MONTHS_SHORT.map((m, i) => {
      const mk = String(i + 1).padStart(2, '0');
      return `${m} pollinators ${pollData[mk] ?? 0}, native plants ${plantData[mk] ?? 0}`;
    }).join('; ');

  const svgParts = [
    `<svg role="img" aria-label="${_escAttr(ariaLabel)}"`,
    ` xmlns="http://www.w3.org/2000/svg"`,
    ` viewBox="0 0 ${svgW} ${totalH}"`,
    ` preserveAspectRatio="none"`,
    ` style="width:100%;height:${totalH}px;display:block;">`,
    `<title>Monthly sightings ${_escText(String(year))}</title>`,
  ];

  for (let i = 0; i < 12; i++) {
    const mk    = String(i + 1).padStart(2, '0');
    const pVal  = pollData[mk]  ?? 0;
    const nVal  = plantData[mk] ?? 0;
    const slotX = PAD_L + i * slotW;
    const cx    = slotX + slotW / 2;

    // Pollinator bar (left)
    const pBarH = Math.max(pVal > 0 ? 2 : 0, (pVal / maxVal) * barAreaH);
    const px    = slotX + groupGap;
    const py    = GROUPED_VALUE_H + (barAreaH - pBarH);
    svgParts.push(
      `<rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${barW.toFixed(1)}" height="${pBarH.toFixed(1)}"`,
      ` fill="${BAR_COLOR_POLL}" rx="1" aria-hidden="true"/>`,
    );

    // Native-plant bar (right)
    const nBarH = Math.max(nVal > 0 ? 2 : 0, (nVal / maxVal) * barAreaH);
    const nx    = slotX + groupGap + barW;
    const ny    = GROUPED_VALUE_H + (barAreaH - nBarH);
    svgParts.push(
      `<rect x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" width="${barW.toFixed(1)}" height="${nBarH.toFixed(1)}"`,
      ` fill="${BAR_COLOR_PLANT}" rx="1" aria-hidden="true"/>`,
    );

    // Month label
    svgParts.push(
      `<text x="${cx.toFixed(1)}" y="${(GROUPED_H + GROUPED_LABEL_H).toFixed(1)}"`,
      ` text-anchor="middle" font-size="6.5" fill="#9ca3af" aria-hidden="true">`,
      _escText(MONTHS_SHORT[i]),
      `</text>`,
    );
  }

  // Legend
  svgParts.push(
    `<rect x="${PAD_L}" y="3" width="7" height="5" fill="${BAR_COLOR_POLL}" rx="1"/>`,
    `<text x="${PAD_L + 9}" y="8" font-size="6.5" fill="#d1fae5">Pollinators</text>`,
    `<rect x="80" y="3" width="7" height="5" fill="${BAR_COLOR_PLANT}" rx="1"/>`,
    `<text x="89" y="8" font-size="6.5" fill="#bbf7d0">Native plants</text>`,
  );

  svgParts.push('</svg>');
  container.innerHTML = svgParts.join('');
}

// ── Top-species table ─────────────────────────────────────────────────────────

/**
 * Render a two-column species table into a container.
 *
 * @param {string} containerId
 * @param {{name:string, count:number}[]} topPollinators
 * @param {{name:string, count:number}[]} topNativePlants
 */
export function renderSpeciesTable(containerId, topPollinators, topNativePlants) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const noData = !topPollinators?.length && !topNativePlants?.length;
  if (noData) {
    container.innerHTML = '<p class="layer-desc" style="color:#9ca3af;font-size:11px;">Species data not available — re-harvest this year to generate it.</p>';
    return;
  }

  const makeList = (items, label, color) => {
    if (!items?.length) return '';
    const rows = items.slice(0, 10).map(({ name, count }) =>
      `<li class="species-row"><span class="species-name">${_escText(name)}</span><span class="species-count">${_fmt(count)}</span></li>`
    ).join('');
    return `<div class="species-col"><p class="species-col-label" style="color:${color};">${_escText(label)}</p><ol class="species-list">${rows}</ol></div>`;
  };

  container.innerHTML =
    `<div class="species-table">${makeList(topPollinators, 'Pollinators', '#6ee7b7')}${makeList(topNativePlants, 'Native plants', '#86efac')}</div>`;
}
