#!/usr/bin/env node
/**
 * scripts/fetch-journeynorth.js
 *
 * Downloads Journey North monarch butterfly & milkweed observations from the
 * Environmental Data Initiative (EDI) repository and filters to the Wisconsin /
 * Lake Michigan corridor (lat 43–46 N, lon -90.5–-86 W).
 *
 * Output: data/journeynorth_monarchs.json  (compact GeoJSON FeatureCollection)
 *
 * Usage:   node scripts/fetch-journeynorth.js
 * Requires: Node.js 18+, no npm dependencies.
 *
 * Data source (CC BY 4.0):
 *   Sheehan, N. & Weber-Grullon, L. (2021). Journey North - Monarch Butterfly and
 *   Milkweed observations by volunteer community scientists across Central and North
 *   America (1996-2020) ver 1. Environmental Data Initiative.
 *   https://doi.org/10.6073/pasta/f7d7bef57f94b33b8a18a26954252412
 */
import https from 'https';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_URL = 'https://pasta.lternet.edu/package/data/eml/edi/949/1/02f2be4d90198702c46fa36556f3749a';
const OUT_PATH = path.resolve(__dirname, '..', 'data', 'journeynorth_monarchs.json');

// Generous bounding box around the Wisconsin / Lake Michigan migration corridor.
// Wider than the 15 km study area intentionally — this is a regional migration layer.
const LAT_MIN = 43.0, LAT_MAX = 46.0;
const LON_MIN = -90.5, LON_MAX = -86.0;

// Map the verbose Journey North reporting categories to short obs_type codes
// used for color-coding in the map layer.
function obsType(species) {
  const s = (species || '').toLowerCase();
  if (s.includes('roost'))                      return 'roost';
  if (s.includes('egg') || s.includes('larva')) return 'egg_larva';
  if (s.includes('milkweed'))                   return 'milkweed';
  return 'adult'; // adults, first sighted, peak migration, other, captive-reared
}

// ── Minimal RFC 4180 CSV line parser ─────────────────────────────────────────
// Handles double-quoted fields (with embedded commas and escaped double-quotes).
// Does NOT handle fields with literal newlines — the Journey North dataset uses
// HTML entities (<br>, <P>) for multi-line comments, so this is safe.
function parseCsvFields(line) {
  const fields = [];
  let field = '', inQuote = false;
  for (let i = 0; i <= line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"')            { inQuote = false; }
      else if (ch !== undefined)      { field += ch; }
    } else {
      if (ch === '"')                 { inQuote = true; }
      else if (ch === ',' || ch === undefined) { fields.push(field); field = ''; }
      else                            { field += ch; }
    }
  }
  return fields;
}

// ── Streaming CSV reader ──────────────────────────────────────────────────────
// Buffers chunks and emits complete lines for the callback.
// Handles \r\n and \n delimiters.
function streamCsvLines(inStream, onLine) {
  return new Promise((resolve, reject) => {
    let buf = '';
    inStream.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
    });
    inStream.on('end', () => {
      if (buf.trim()) onLine(buf.trim());
      resolve();
    });
    inStream.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  console.log('Fetching CSV from EDI repository…');
  console.log('  URL:', DATA_URL);
  console.log('  Bounding box: lat', LAT_MIN, '–', LAT_MAX, '  lon', LON_MIN, '–', LON_MAX);
  console.log('  (This is a 68 MB file — download may take 1–2 minutes)');

  await new Promise((resolve, reject) => {
    const req = https.get(DATA_URL, { headers: { 'User-Agent': 'BayHive/1.0 (Green Bay pollinator habitat tool)' } }, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} — ${res.statusMessage}`));
        res.resume();
        return;
      }

      let headerRow = null;
      let colDate = -1, colSpecies = -1, colNumber = -1, colLat = -1, colLon = -1;
      let total = 0, kept = 0;
      const features = [];

      streamCsvLines(res, line => {
        if (!headerRow) {
          headerRow = parseCsvFields(line);
          colDate    = headerRow.indexOf('date');
          colSpecies = headerRow.indexOf('species');
          colNumber  = headerRow.indexOf('number');
          colLat     = headerRow.indexOf('latitude');
          colLon     = headerRow.indexOf('longitude');

          if (colLat === -1 || colLon === -1) {
            reject(new Error('Could not find latitude/longitude columns in CSV header: ' + headerRow.slice(0, 8).join(', ')));
            return;
          }
          console.log('  Header detected:', headerRow.slice(0, 7).join(', ') + ', …');
          return;
        }

        total++;
        if (total % 50000 === 0) process.stdout.write(`  … ${total.toLocaleString()} rows processed, ${kept} kept\r`);

        const cols = parseCsvFields(line);
        if (cols.length <= Math.max(colLat, colLon)) return;

        const lat = parseFloat(cols[colLat]);
        const lon = parseFloat(cols[colLon]);

        // Skip missing/sentinel coordinates
        if (!isFinite(lat) || !isFinite(lon)) return;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        if (lat === -999999 || lon === -999999) return;

        // Bounding box filter
        if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) return;

        const date    = (colDate    >= 0 ? cols[colDate]    : '') || null;
        const species = (colSpecies >= 0 ? cols[colSpecies] : '') || '';
        const number  = colNumber >= 0 ? (parseInt(cols[colNumber], 10) || 1) : 1;
        const year    = date ? +date.slice(0, 4) : null;

        kept++;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            obs_type: obsType(species),
            type:     species,
            date,
            year,
            n: number,
          },
        });
      })
        .then(() => {
          process.stdout.write('\n');
          console.log(`  Processed ${total.toLocaleString()} rows, ${kept} within bounding box.`);

          const fc = { type: 'FeatureCollection', features };
          fs.writeFileSync(OUT_PATH, JSON.stringify(fc));
          const kb = Math.round(Buffer.byteLength(JSON.stringify(fc)) / 1024);
          console.log(`\nDone. Output: ${OUT_PATH}  (${kb} KB, ${features.length} features)`);
          resolve();
        })
        .catch(reject);
    });
    req.on('error', reject);
  });
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
