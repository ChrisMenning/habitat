/**
 * export.js — Printable / shareable HTML snapshot report.
 *
 * Captures the current state of all loaded data and generates a self-contained
 * HTML document suitable for printing or saving. Opens in a new tab so the
 * user can use the browser's native Print / Save-as-PDF functionality.
 *
 * The report includes:
 *   - Bay Hive header with current date
 *   - Intelligence summary counts
 *   - Active alerts (text)
 *   - Habitat site inventory table (corridor + waystations)
 *   - Sighting summary by layer
 *   - Active filter state
 *   - Map viewport info (zoom, center)
 */

import { esc } from './ui.js';

/** @type {ReportData} */
let _data = {};

/**
 * Store snapshot data for the export.
 * Call this in app.js after each successful load.
 *
 * @param {object} d
 * @param {number}             d.corridorCount
 * @param {number}             d.waystationCount
 * @param {number}             d.inatCount
 * @param {number}             d.gbifCount
 * @param {string}             d.dateFrom
 * @param {string}             d.dateTo
 * @param {import('./alerts.js').Alert[]} d.alerts
 * @param {GeoJSON.Feature[]}  d.corridorFeatures
 * @param {GeoJSON.Feature[]}  d.waystationFeatures
 * @param {number}             d.mapZoom
 * @param {[number,number]}    d.mapCenter
 * @param {string[]}           d.activeFilters
 */
export function setExportData(d) {
  _data = { ..._data, ...d };
}

/**
 * Generates and opens the HTML report in a new browser tab.
 */
export function exportReport() {
  const now        = new Date();
  const dateStr    = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const {
    corridorCount    = 0,
    waystationCount  = 0,
    inatCount        = 0,
    gbifCount        = 0,
    dateFrom         = '',
    dateTo           = '',
    alerts           = [],
    corridorFeatures = [],
    waystationFeatures = [],
    mapZoom          = 0,
    mapCenter        = [0, 0],
    activeFilters    = [],
  } = _data;

  // ── Alert rows ─────────────────────────────────────────────────────────────
  const alertRows = alerts.length
    ? alerts.map(a => `<tr><td>${a.icon}</td><td>${escHtml(a.text)}</td></tr>`).join('')
    : '<tr><td colspan="2">No alerts</td></tr>';

  // ── Corridor site table ───────────────────────────────────────────────────
  const corridorRows = corridorFeatures.slice(0, 50).map(f => {
    const p = f.properties;
    const area = p.area_sqft ? `${(+p.area_sqft).toLocaleString()} sq ft` : '—';
    return `<tr><td>${escHtml(p.name ?? '—')}</td><td>${area}</td></tr>`;
  }).join('');

  // ── Waystation table ──────────────────────────────────────────────────────
  const wsRows = waystationFeatures.slice(0, 60).map(f => {
    const p = f.properties;
    const approx = p.approximate ? ' <span class="approx">(approx)</span>' : '';
    return `<tr><td>${escHtml(p.name || p.registrant || '—')}${approx}</td><td>${escHtml(p.registered ?? '—')}</td><td>${escHtml(p.size ?? '—')}</td></tr>`;
  }).join('');

  const filterStr = activeFilters.length ? activeFilters.join(', ') : 'None';
  const dateRange = (dateFrom || dateTo) ? `${dateFrom || '(all)'} to ${dateTo || '(all)'}` : 'All dates';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bay Hive Report — ${escHtml(dateStr)}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; color: #1e293b; max-width: 900px; margin: 0 auto; padding: 24px; }
  h1   { font-size: 22px; color: #14532d; margin: 0 0 2px; }
  h2   { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin: 20px 0 6px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .meta { font-size: 11px; color: #94a3b8; margin-bottom: 20px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .summary-card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; }
  .summary-card .val { font-size: 22px; font-weight: 700; color: #14532d; }
  .summary-card .lbl { font-size: 10px; color: #64748b; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  th    { text-align: left; background: #f8fafc; padding: 5px 8px; border-bottom: 2px solid #e2e8f0; }
  td    { padding: 4px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .alert-warn { color: #b45309; } .alert-info { color: #1d4ed8; }
  .alert-opportunity { color: #15803d; } .alert-positive { color: #16a34a; }
  .approx { color: #f59e0b; font-size: 10px; }
  @media print { body { padding: 12px; } }
</style>
</head>
<body>
<h1>🐝 Bay Hive</h1>
<div class="meta">Pollinator Habitat Intelligence Report &nbsp;·&nbsp; Generated ${escHtml(dateStr)} at ${escHtml(timeStr)} &nbsp;·&nbsp; Observation range: ${escHtml(dateRange)} &nbsp;·&nbsp; Active filters: ${escHtml(filterStr)}</div>

<h2>Situational Summary</h2>
<div class="summary-grid">
  <div class="summary-card"><div class="val">${corridorCount}</div><div class="lbl">Corridor sites</div></div>
  <div class="summary-card"><div class="val">${waystationCount}</div><div class="lbl">Monarch waystations</div></div>
  <div class="summary-card"><div class="val">${inatCount.toLocaleString()}</div><div class="lbl">iNat sightings</div></div>
  <div class="summary-card"><div class="val">${gbifCount.toLocaleString()}</div><div class="lbl">GBIF records</div></div>
</div>

<h2>Intelligence Alerts (${alerts.length})</h2>
<table>
  <thead><tr><th></th><th>Alert</th></tr></thead>
  <tbody>${alertRows}</tbody>
</table>

<h2>Pollinator Corridor Sites</h2>
<table>
  <thead><tr><th>Site name</th><th>Area</th></tr></thead>
  <tbody>${corridorRows || '<tr><td colspan="2">No data loaded</td></tr>'}</tbody>
</table>

<h2>Monarch Waystations (${waystationCount} total, first 60 shown)</h2>
<table>
  <thead><tr><th>Habitat / Registrant</th><th>Registered</th><th>Size</th></tr></thead>
  <tbody>${wsRows || '<tr><td colspan="3">No data loaded</td></tr>'}</tbody>
</table>

<p style="font-size:10px;color:#94a3b8;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:8px;">
  Data sources: iNaturalist API, GBIF, USGS PAD-US v3.0, WI DNR, Green Bay Conservation Corps, Monarch Watch.
  Map center: ${mapCenter[1].toFixed(4)}°N ${Math.abs(mapCenter[0]).toFixed(4)}°W · Zoom ${mapZoom.toFixed(1)}.
</p>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  // Revoke after the tab has had time to load the blob
  if (win) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Simple HTML escaper (not using esc() from ui.js to keep this module self-contained)
function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
