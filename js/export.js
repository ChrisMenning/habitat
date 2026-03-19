/**
 * export.js — Printable / shareable HTML snapshot report.
 *
 * Captures the current state of all loaded data and generates a self-contained
 * HTML document suitable for printing or saving. Opens in a new tab so the
 * user can use the browser's native Print / Save-as-PDF functionality.
 */

import { getMap }      from './map.js';
import { nestingTier } from './nesting.js';
import { doyToLabel }  from './climate.js';

let _data = {};

/** Store snapshot data for the export. Call in app.js after each successful load. */
export function setExportData(d) {
  _data = { ..._data, ...d };
}

/** Save the current map view as a PNG file. */
export function exportMapPng() {
  const map = getMap();
  if (!map) return;
  const dataUrl = map.getCanvas().toDataURL('image/png');
  const a = document.createElement('a');
  a.href     = dataUrl;
  a.download = `bayhive-map-${new Date().toISOString().slice(0, 10)}.png`;
  a.click();
}

/** Generates and opens the full HTML intelligence report in a new tab. */
export function exportReport() {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });

  const {
    // Core counts
    corridorCount      = 0,
    waystationCount    = 0,
    inatCount          = 0,
    gbifCount          = 0,
    hnpCount           = 0,
    ebirdCount         = 0,
    habitatNodeCount   = 0,
    pollinatorCount    = 0,
    nativeSpeciesCount = 0,
    corridorSqFt       = 0,
    padusCount         = 0,
    snaCount           = 0,
    dnrManagedCount    = 0,
    // Features
    alerts             = [],
    corridorFeatures   = [],
    waystationFeatures = [],
    topSpecies         = [],
    pfasFeatures       = [],
    pesticideCounties  = [],
    nestingScores      = new Map(),
    // Rolled-up counts by layer
    inatByLayer        = {},
    gbifByLayer        = {},
    // Structured data
    cdlStats           = null,
    quickStats         = null,
    climateState       = null,
    // Map state
    mapZoom            = 0,
    mapCenter          = [0, 0],
    activeFilters      = [],
  } = _data;

  // ── Map snapshot ───────────────────────────────────────────────────────────
  const mapSnapshot = (() => {
    try { const c = getMap()?.getCanvas(); return c ? c.toDataURL('image/png') : null; }
    catch { return null; }
  })();

  // ── GDD / climate helpers ──────────────────────────────────────────────────
  const gdd     = climateState?.current ? Math.round(climateState.current.accumulatedGDD) : null;
  const gddPhases = [
    { min: 1200, label: 'Monarch peak migration'   },
    { min: 750,  label: 'Peak native bee season'   },
    { min: 400,  label: 'Bumble queens active'     },
    { min: 200,  label: 'Mason & mining bee emergence' },
    { min: 0,    label: 'Pre-season'               },
  ];
  const gddPhase   = gdd !== null ? (gddPhases.find(p => gdd >= p.min)?.label ?? 'Pre-season') : null;
  const normalGdd  = climateState?.normalGdd   ? Math.round(climateState.normalGdd)   : null;
  const pctDev     = climateState?.pctDeviation != null ? climateState.pctDeviation  : null;
  const GDD_THRESHOLDS = [
    { gdd: 200,  label: 'Mason & mining bee emergence' },
    { gdd: 400,  label: 'Bumble bee queens active'     },
    { gdd: 750,  label: 'Peak native bee season'       },
    { gdd: 1200, label: 'Monarch peak migration'       },
  ];

  // ── CSS ────────────────────────────────────────────────────────────────────
  const css = `
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px;
           color: #1e293b; max-width: 960px; margin: 0 auto; padding: 24px; }
    h1   { font-size: 22px; color: #14532d; margin: 0 0 2px; }
    h2   { font-size: 11px; font-weight: 700; text-transform: uppercase;
           letter-spacing: 0.08em; color: #64748b; margin: 24px 0 6px;
           border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    .meta { font-size: 11px; color: #94a3b8; margin-bottom: 20px; }
    .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
    .grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 16px; }
    .card  { border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; }
    .card .val { font-size: 20px; font-weight: 700; color: #14532d; }
    .card .lbl { font-size: 10px; color: #64748b; margin-top: 2px; }
    table  { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
    th     { text-align: left; background: #f8fafc; padding: 5px 8px;
             border-bottom: 2px solid #e2e8f0; white-space: nowrap; }
    td     { padding: 4px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .empty { color: #94a3b8; font-style: italic; }
    .badge { display:inline-block; padding:1px 6px; border-radius:3px; font-size:10px;
             font-weight:600; color:#fff; white-space:nowrap; }
    .lvl-warn        { background:#b45309; }
    .lvl-info        { background:#1d4ed8; }
    .lvl-opportunity { background:#15803d; }
    .lvl-positive    { background:#16a34a; }
    .lvl-balance     { background:#64748b; }
    .tier-good       { color:#6b3a2a; font-weight:600; }
    .tier-moderate   { color:#b58a5a; font-weight:600; }
    .tier-low        { color:#9ca3af; font-weight:600; }
    .band-1 { color:#16a34a; } .band-2 { color:#ca8a04; }
    .band-3 { color:#dc2626; } .band-4 { color:#7c3aed; }
    .num { text-align:right; }
    a    { color:#1d4ed8; }
    @media print { .no-print { display:none; } body { padding: 12px; } }
  `;

  // ── Section builders ───────────────────────────────────────────────────────

  function mapSection() {
    if (!mapSnapshot) return '';
    return `<h2>Map Snapshot</h2>
    <img src="${mapSnapshot}" style="max-width:100%;border-radius:6px;border:1px solid #e2e8f0;margin-bottom:16px;" alt="Map snapshot">`;
  }

  function summarySection() {
    const areaStr = corridorSqFt > 0
      ? `${(corridorSqFt / 43560).toLocaleString('en-US', {maximumFractionDigits:1})} ac`
      : '—';
    const gddStr  = gdd !== null ? gdd.toLocaleString() : '—';
    return `<h2>Situational Summary</h2>
    <div class="grid5">
      <div class="card"><div class="val">${habitatNodeCount.toLocaleString()}</div><div class="lbl">Habitat nodes</div></div>
      <div class="card"><div class="val">${areaStr}</div><div class="lbl">Corridor area</div></div>
      <div class="card"><div class="val">${pollinatorCount.toLocaleString()}</div><div class="lbl">Pollinator obs</div></div>
      <div class="card"><div class="val">${nativeSpeciesCount.toLocaleString()}</div><div class="lbl">Native spp observed</div></div>
      <div class="card"><div class="val">${alerts.length}</div><div class="lbl">Active alerts</div></div>
    </div>
    <div class="grid5">
      <div class="card"><div class="val">${corridorCount}</div><div class="lbl">Corridor sites</div></div>
      <div class="card"><div class="val">${waystationCount.toLocaleString()}</div><div class="lbl">Waystations</div></div>
      <div class="card"><div class="val">${hnpCount.toLocaleString()}</div><div class="lbl">HNP yards</div></div>
      <div class="card"><div class="val">${ebirdCount.toLocaleString()}</div><div class="lbl">eBird sightings</div></div>
      <div class="card"><div class="val">${gddStr}</div><div class="lbl">GDD base-50</div></div>
    </div>`;
  }

  function alertsSection() {
    const rows = alerts.length
      ? alerts.map(a => {
          const badgeCls = `badge lvl-${escHtml(a.level)}`;
          return `<tr>
            <td><span class="${badgeCls}">${escHtml(a.level)}</span></td>
            <td>${escHtml(a.icon)}</td>
            <td>${escHtml(a.text)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="3" class="empty">No active alerts</td></tr>`;
    return `<h2>Intelligence Alerts (${alerts.length})</h2>
    <table>
      <thead><tr><th>Severity</th><th style="width:24px"></th><th>Alert</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function habitatSection() {
    // Corridor sites
    const corrRows = corridorFeatures.slice(0, 75).map(f => {
      const p    = f.properties ?? {};
      const area = p.area_sqft ? `${(+p.area_sqft / 43560).toLocaleString('en-US',{maximumFractionDigits:2})} ac` : '—';
      const ns   = nestingScores.get(p.name ?? '');
      let nestCell = '—';
      if (ns) {
        const { label, color } = nestingTier(ns.score);
        const tier = ns.score >= 67 ? 'good' : ns.score >= 34 ? 'moderate' : 'low';
        nestCell = `<span class="tier-${tier}" style="color:${escHtml(color)}">${escHtml(label)} (${ns.score})</span>`;
      }
      return `<tr><td>${escHtml(p.name ?? '—')}</td><td class="num">${area}</td><td>${nestCell}</td></tr>`;
    }).join('');

    // Waystations
    const wsRows = waystationFeatures.slice(0, 75).map(f => {
      const p     = f.properties ?? {};
      const approx = p.approximate ? ' <em>(approx)</em>' : '';
      return `<tr>
        <td>${escHtml(p.name || p.registrant || '—')}${approx}</td>
        <td>${escHtml(p.registered ?? '—')}</td>
        <td>${escHtml(p.size ?? '—')}</td>
      </tr>`;
    }).join('');

    return `<h2>Habitat Network</h2>
    <p style="font-size:11px;color:#64748b;margin:0 0 8px">
      ${corridorCount} pollinator corridor sites · ${waystationCount} Monarch waystations · ${hnpCount} Homegrown National Park yards
    </p>
    <table>
      <thead><tr><th>Corridor site</th><th class="num">Area</th><th>Nesting suitability</th></tr></thead>
      <tbody>${corrRows || `<tr><td colspan="3" class="empty">No corridor data</td></tr>`}</tbody>
    </table>
    <table>
      <thead><tr><th>Waystation / Registrant</th><th>Registered</th><th>Size</th></tr></thead>
      <tbody>${wsRows || `<tr><td colspan="3" class="empty">No waystation data</td></tr>`}</tbody>
    </table>`;
  }

  function biodiversitySection() {
    const inatRows = [
      ['Pollinators (iNat)',          inatByLayer.pollinators  ?? 0],
      ['Native plants (iNat)',        inatByLayer.nativePlants ?? 0],
      ['Other plants (iNat)',         inatByLayer.otherPlants  ?? 0],
      ['Other wildlife (iNat)',       inatByLayer.otherWildlife ?? 0],
      ['Pollinators (GBIF)',          gbifByLayer.pollinators  ?? 0],
      ['Native plants (GBIF)',        gbifByLayer.nativePlants ?? 0],
      ['Non-native plants (GBIF)',    gbifByLayer.nonNativePlants ?? 0],
      ['Bird sightings (eBird)',      ebirdCount],
    ].map(([layer, n]) =>
      `<tr><td>${escHtml(layer)}</td><td class="num">${n.toLocaleString()}</td></tr>`
    ).join('');

    const speciesRows = topSpecies.length
      ? topSpecies.map((s, i) =>
          `<tr><td class="num">${i + 1}</td><td>${escHtml(s.name)}</td><td class="num">${s.count.toLocaleString()}</td></tr>`
        ).join('')
      : `<tr><td colspan="3" class="empty">No pollinator sightings</td></tr>`;

    return `<h2>Biodiversity Observations</h2>
    <table>
      <thead><tr><th>Data layer</th><th class="num">Observations</th></tr></thead>
      <tbody>${inatRows}</tbody>
    </table>
    <h2>Top Pollinator Species (iNat)</h2>
    <table>
      <thead><tr><th class="num">#</th><th>Species</th><th class="num">Sightings</th></tr></thead>
      <tbody>${speciesRows}</tbody>
    </table>`;
  }

  function agricultureSection() {
    if (!cdlStats && !quickStats) {
      return `<h2>Agricultural Context</h2><p class="empty">CDL / NASS data not available.</p>`;
    }
    let cdlHtml = '';
    if (cdlStats) {
      const cropRows = (cdlStats.topBeeCrops ?? []).map(c =>
        `<tr><td>${escHtml(c.category)}</td><td class="num">${(+c.acreage).toLocaleString('en-US',{maximumFractionDigits:0})} ac</td></tr>`
      ).join('');
      const beePct  = cdlStats.beePct  != null ? cdlStats.beePct.toFixed(1)  : '—';
      const beeOfCropPct = cdlStats.beeOfCropPct != null ? cdlStats.beeOfCropPct.toFixed(1) : '—';
      cdlHtml = `
      <p style="font-size:11px;color:#64748b;margin:0 0 8px">
        Bee-dependent crops: <strong>${beePct}%</strong> of total land area ·
        <strong>${beeOfCropPct}%</strong> of cultivated cropland
      </p>
      <table>
        <thead><tr><th>Top bee-dependent crops (CDL 2023)</th><th class="num">Area</th></tr></thead>
        <tbody>${cropRows || `<tr><td colspan="2" class="empty">No bee-dependent crops detected</td></tr>`}</tbody>
      </table>`;
    }
    let nassHtml = '';
    if (quickStats?.available) {
      const coloniesStr = quickStats.colonies != null
        ? `${quickStats.colonies.toLocaleString()} colonies (${quickStats.coloniesYear ?? '—'})`
        : 'Unavailable';
      const notableRows = Object.entries(quickStats.notableAcres ?? {}).map(([crop, ac]) =>
        `<tr><td>${escHtml(crop)}</td><td class="num">${(+ac).toLocaleString('en-US',{maximumFractionDigits:0})} ac</td></tr>`
      ).join('');
      nassHtml = `
      <p style="font-size:11px;color:#64748b;margin:8px 0 4px">USDA NASS QuickStats — Brown County</p>
      <table>
        <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
        <tbody>
          <tr><td>Managed honey bee colonies</td><td class="num">${escHtml(coloniesStr)}</td></tr>
          ${notableRows}
        </tbody>
      </table>`;
    } else if (quickStats != null && !quickStats.available) {
      nassHtml = `<p style="font-size:11px;color:#94a3b8">NASS QuickStats API not configured.</p>`;
    }
    return `<h2>Agricultural Context</h2>${cdlHtml}${nassHtml}`;
  }

  function climateSection() {
    if (!climateState) {
      return `<h2>Climate &amp; Phenology</h2><p class="empty">Climate data not available.</p>`;
    }
    const gddStr    = gdd !== null ? `${gdd.toLocaleString()} GDD` : '—';
    const normalStr = normalGdd  !== null ? `${normalGdd.toLocaleString()} GDD` : '—';
    const devStr    = pctDev     !== null ? `${pctDev >= 0 ? '+' : ''}${pctDev.toFixed(1)}% vs normal` : '—';
    const phaseStr  = gddPhase   ?? '—';

    // Frost dates
    const frost = climateState.frost;
    let frostHtml = '';
    if (frost?.springFrost32?.p50 && frost?.fallFrost32?.p50) {
      frostHtml = `<tr><td>Last spring frost (50% prob, 32°F)</td><td>~${escHtml(doyToLabel(frost.springFrost32.p50))}</td></tr>
                   <tr><td>First fall frost (50% prob, 32°F)</td><td>~${escHtml(doyToLabel(frost.fallFrost32.p50))}</td></tr>`;
    }

    // GDD threshold milestones
    const threshRows = GDD_THRESHOLDS.map(t => {
      const reached = gdd !== null && gdd >= t.gdd;
      return `<tr>
        <td>${escHtml(t.label)}</td>
        <td class="num">${t.gdd.toLocaleString()} GDD</td>
        <td>${reached ? '✅ Reached' : '⏳ Pending'}</td>
      </tr>`;
    }).join('');

    return `<h2>Climate &amp; Phenology</h2>
    <table>
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Accumulated GDD (base 50°F)</td><td>${escHtml(gddStr)}</td></tr>
        <tr><td>Normal GDD for today</td><td>${escHtml(normalStr)}</td></tr>
        <tr><td>Deviation from normal</td><td>${escHtml(devStr)}</td></tr>
        <tr><td>Current season phase</td><td>${escHtml(phaseStr)}</td></tr>
        ${frostHtml}
      </tbody>
    </table>
    <table>
      <thead><tr><th>Phenological milestone</th><th class="num">Threshold</th><th>Status</th></tr></thead>
      <tbody>${threshRows}</tbody>
    </table>`;
  }

  function threatsSection() {
    // PFAS sites
    const pfasRows = pfasFeatures.slice(0, 50).map(f => {
      const p = f.properties ?? {};
      const pfosStr = p.pfos ? p.pfos : '—';
      const pfoaStr = p.pfoa ? p.pfoa : '—';
      const linkHtml = p.url
        ? ` <a href="${escHtml(p.url)}" target="_blank" rel="noopener noreferrer">[report]</a>`
        : '';
      return `<tr>
        <td>${escHtml(p.name ?? '—')}${linkHtml}</td>
        <td>${escHtml(String(p.year ?? '—'))}</td>
        <td class="num">${escHtml(pfosStr)}</td>
        <td class="num">${escHtml(pfoaStr)}</td>
      </tr>`;
    }).join('');

    // Pesticide counties
    const sorted = [...pesticideCounties].sort((a, b) => (b.properties?.score ?? 0) - (a.properties?.score ?? 0));
    const pestRows = sorted.map(f => {
      const p    = f.properties ?? {};
      const band = p.band ?? 0;
      return `<tr>
        <td>${escHtml(p.name ?? '—')}</td>
        <td><span class="band-${band}">${escHtml(p.band_label ?? '—')}</span></td>
        <td class="num">${p.score != null ? p.score.toFixed(2) : '—'}</td>
      </tr>`;
    }).join('');

    return `<h2>Threats &amp; Hazards</h2>
    <p style="font-size:11px;color:#64748b;margin:0 0 6px">PFAS chemical hazard sites within map area (WI DNR)</p>
    <table>
      <thead><tr><th>Site name</th><th>Year</th><th class="num">PFOS (ppt)</th><th class="num">PFOA (ppt)</th></tr></thead>
      <tbody>${pfasRows || `<tr><td colspan="4" class="empty">No PFAS sites in current view</td></tr>`}</tbody>
    </table>
    <p style="font-size:11px;color:#64748b;margin:8px 0 6px">Pesticide intensity by county (USDA NASS, estimated risk to pollinators)</p>
    <table>
      <thead><tr><th>County</th><th>Intensity band</th><th class="num">Score</th></tr></thead>
      <tbody>${pestRows || `<tr><td colspan="3" class="empty">No pesticide data</td></tr>`}</tbody>
    </table>`;
  }

  function protectedLandsSection() {
    return `<h2>Protected &amp; Managed Lands</h2>
    <table>
      <thead><tr><th>Layer</th><th class="num">Count</th></tr></thead>
      <tbody>
        <tr><td>USGS PAD-US protected areas</td><td class="num">${padusCount.toLocaleString()}</td></tr>
        <tr><td>WI DNR State Natural Areas</td><td class="num">${snaCount.toLocaleString()}</td></tr>
        <tr><td>WI DNR Managed Lands</td><td class="num">${dnrManagedCount.toLocaleString()}</td></tr>
      </tbody>
    </table>`;
  }

  function footer() {
    const filterStr = activeFilters.length ? activeFilters.join(', ') : 'None';
    return `<p style="font-size:10px;color:#94a3b8;margin-top:28px;border-top:1px solid #f1f5f9;padding-top:10px;">
      Data sources: iNaturalist API · GBIF · NOAA GHCND · USDA NASS QuickStats · CDL CropScape ·
      USGS PAD-US v3.0 · WI DNR · Green Bay Conservation Corps · Monarch Watch · eBird ·
      Homegrown National Park · PFAS MapServer (WI DNR).<br>
      Map center: ${mapCenter[1].toFixed(4)}°N ${Math.abs(mapCenter[0]).toFixed(4)}°W · Zoom ${mapZoom.toFixed(1)} ·
      Active filters: ${escHtml(filterStr)} ·
      Report generated ${escHtml(dateStr)} at ${escHtml(timeStr)}.
    </p>`;
  }

  // ── Assemble HTML ──────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Bay Hive Report — ${escHtml(dateStr)}</title>
<style>${css}</style>
</head>
<body>
<h1>🐝 Bay Hive — Pollinator Habitat Intelligence Report</h1>
<div class="meta">Generated ${escHtml(dateStr)} at ${escHtml(timeStr)}</div>
${mapSection()}
${summarySection()}
${alertsSection()}
${habitatSection()}
${biodiversitySection()}
${agricultureSection()}
${climateSection()}
${threatsSection()}
${protectedLandsSection()}
${footer()}
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function escHtml(v) {
  return String(v ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
