#!/usr/bin/env node
/**
 * scripts/fetch-iem.js
 *
 * Downloads daily TMAX/TMIN observations for the Green Bay Austin Straubel
 * ASOS station (GRB) from the Iowa Environmental Mesonet (IEM) archive and
 * writes snapshots/observed-temps-GRB-{year}.json — the file js/climate.js
 * reads (via /api/observed-temps/{year}) as the preferred source for
 * current-year GDD, since NOAA/NCEI public data access has been unreliable.
 *
 * IEM is an independent archive (Iowa State University) unaffected by
 * federal data-access disruptions; see js/climate.js header comment.
 *
 * Usage:
 *   node scripts/fetch-iem.js              — refreshes the current year only
 *   node scripts/fetch-iem.js 2025         — refreshes just 2025
 *   node scripts/fetch-iem.js 2025 2026    — refreshes both
 *
 * For a year in the past, fetches Jan 1 – Dec 31. For the current year,
 * fetches Jan 1 – yesterday (today's ASOS observation may still be partial).
 *
 * Requires: Node.js 18+, no npm dependencies.
 * Data source: Iowa Environmental Mesonet ASOS archive, Iowa State University.
 *   https://mesonet.agron.iastate.edu/
 */
import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'snapshots');

const STATION      = 'GRB';
const NETWORK      = 'WI_ASOS';
const STATION_NAME = 'GREEN BAY AUSTIN STRAUBEL INTL AP, WI US';
const SOURCE       = 'Iowa Environmental Mesonet (IEM) ASOS archive — Iowa State University. Observed daily temperature data; not federal government-hosted.';
const SOURCE_URL   = 'https://mesonet.agron.iastate.edu/';

/** Fetches the raw daily-summary CSV for [start, end] (both Date objects) from IEM. */
function fetchCsv(start, end) {
  const params = new URLSearchParams({
    network: NETWORK,
    stations: STATION,
    year1:  String(start.getFullYear()),
    month1: String(start.getMonth() + 1),
    day1:   String(start.getDate()),
    year2:  String(end.getFullYear()),
    month2: String(end.getMonth() + 1),
    day2:   String(end.getDate()),
    format: 'comma',
  });
  const url = `https://mesonet.agron.iastate.edu/cgi-bin/request/daily.py?${params}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BayHive/1.0 (Green Bay pollinator habitat tool)' } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} — ${res.statusMessage}`));
        res.resume();
        return;
      }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/** Minimal CSV parser — IEM's daily.py output has no quoted/embedded-comma fields. */
function parseCsv(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const iDay  = header.indexOf('day');
  const iTmax = header.indexOf('max_temp_f');
  const iTmin = header.indexOf('min_temp_f');
  if (iDay === -1 || iTmax === -1 || iTmin === -1) {
    throw new Error('Unexpected IEM CSV header: ' + header.join(', '));
  }
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return { day: cols[iDay], tmax: cols[iTmax], tmin: cols[iTmin] };
  });
}

/** 1-based day-of-year for a YYYY-MM-DD date string. */
function dateToDoy(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

async function fetchYear(year) {
  const now         = new Date();
  const isCurrent   = year === now.getFullYear();
  const start       = new Date(year, 0, 1);
  const end         = isCurrent
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1) // yesterday
    : new Date(year, 11, 31);

  console.log(`Fetching IEM daily data for ${STATION} ${year} (${start.toISOString().slice(0,10)} – ${end.toISOString().slice(0,10)})…`);
  const csv  = await fetchCsv(start, end);
  const rows = parseCsv(csv);

  const records = [];
  let cumulativeGdd = 0;
  for (const row of rows) {
    const tmaxRaw = parseFloat(row.tmax);
    const tminRaw = parseFloat(row.tmin);
    if (!isFinite(tmaxRaw) || !isFinite(tminRaw)) continue; // 'M' (missing) sentinel etc.
    const tmax = Math.round(tmaxRaw * 10) / 10;
    const tmin = Math.round(tminRaw * 10) / 10;
    const tavg = Math.round((tmax + tmin) / 2 * 10) / 10;
    const gddBase50 = Math.max(0, tavg - 50);
    cumulativeGdd += gddBase50;
    records.push({
      doy:        dateToDoy(row.day),
      date:       row.day.slice(5),   // "YYYY-MM-DD" → "MM-DD"
      tmax, tmin, tavg,
      gddBase50:  Math.round(gddBase50 * 10) / 10,
    });
  }

  const out = {
    station:      STATION,
    stationName:  `${STATION} / USW00014898 ${STATION_NAME}`,
    year,
    source:       SOURCE,
    sourceUrl:    SOURCE_URL,
    retrieved:    now.toISOString().slice(0, 10),
    cumulativeGddBase50: Math.round(cumulativeGdd),
    records,
  };

  const outPath = path.join(OUT_DIR, `observed-temps-GRB-${year}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`  Wrote ${records.length} days → ${outPath} (cumulative GDD base-50: ${out.cumulativeGddBase50})`);
  return out;
}

async function main() {
  const years = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n) && n > 2000);
  const targets = years.length ? years : [new Date().getFullYear()];

  for (const year of targets) {
    await fetchYear(year);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
