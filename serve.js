/**
 * serve.js — Minimal static file server for local development.
 *
 * Usage:  node serve.js
 * Then open:  http://localhost:3000
 *
 * No npm dependencies — uses only Node.js built-ins.
 */

const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT    = 3000;
const ROOT    = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Proxy endpoint ────────────────────────────────────────────────────────────
// Proxies GET /api/hnp-plantings → HNP guest API (which has no CORS headers).
const HNP_UPSTREAM = 'https://map.homegrownnationalpark.org/api/guest/map/plantings?countryCode=US';

function proxyHnp(res) {
  https.get(HNP_UPSTREAM, { timeout: 20000 }, upstream => {
    res.writeHead(upstream.statusCode, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=900',  // 15 min
    });
    upstream.pipe(res);
  }).on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
}

// ── CDL stats proxy ───────────────────────────────────────────────────────
// Proxies GET /api/cdl-stats → USDA NASS CropScape CDL statistics for
// Brown County, WI (FIPS 55009).  The CropScape service returns an XML
// response containing a URL to the actual JSON data file; we follow that
// redirect inline so the browser receives the data directly.
// NB: nassgeodata.gmu.edu sends no CORS headers, hence the proxy.
const CDL_STAT_URL = 'https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLStat?year=2023&fips=55009&format=json';

function proxyCdlStats(res) {
  // Step 1: fetch the CropScape service to get the data URL from XML
  https.get(CDL_STAT_URL, { timeout: 15000 }, xmlRes => {
    let xml = '';
    xmlRes.on('data', chunk => { xml += chunk; });
    xmlRes.on('end', () => {
      // Parse the returnURL out of the NS-wrapped XML response
      const match = xml.match(/<returnURL>([^<]+)<\/returnURL>/);
      if (!match) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'CDL service did not return a data URL' }));
        return;
      }
      // Step 2: fetch the actual JSON data file
      https.get(match[1], { timeout: 15000 }, jsonRes => {
        res.writeHead(jsonRes.statusCode, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'public, max-age=86400',  // 24 h
        });
        jsonRes.pipe(res);
      }).on('error', err => {
        res.writeHead(502);
        res.end(JSON.stringify({ error: err.message }));
      });
    });
  }).on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
}

// ── NLCD tile proxy (per-class pixel filtering) ───────────────────────────────

// CRC32 table for PNG chunk checksums.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf    = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

// Actual RGB values from the MRLC GeoServer NLCD 2021 WMS palette PNG.
// Verified by inspecting the PLTE chunk of a live tile response.
const NLCD_COLORS = {
  11: [ 71, 107, 160],  12: [209, 221, 249],
  21: [221, 201, 201],  22: [216, 147, 130],  23: [237,   0,   0],  24: [170,   0,   0],
  31: [178, 173, 163],
  41: [104, 170,  99],  42: [ 28,  99,  48],  43: [181, 201, 142],
  52: [204, 186, 124],
  71: [226, 226, 193],
  81: [219, 216,  61],  82: [170, 112,  40],
  90: [186, 216, 234],  95: [112, 163, 186],
};

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode PNG filter bytes and return flat RGBA pixel buffer. */
function decodePng(inflated, width, height, bpp) {
  const stride  = 1 + width * bpp;
  const out     = Buffer.alloc(width * height * 4);
  const prevRow = Buffer.alloc(width * bpp);

  for (let y = 0; y < height; y++) {
    const filterByte = inflated[y * stride];
    const raw        = inflated.slice(y * stride + 1, (y + 1) * stride);
    const decoded    = Buffer.alloc(width * bpp);

    for (let i = 0; i < raw.length; i++) {
      const a = i >= bpp ? decoded[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;
      switch (filterByte) {
        case 0: decoded[i] = raw[i]; break;
        case 1: decoded[i] = (raw[i] + a) & 0xFF; break;
        case 2: decoded[i] = (raw[i] + b) & 0xFF; break;
        case 3: decoded[i] = (raw[i] + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: decoded[i] = (raw[i] + paethPredictor(a, b, c)) & 0xFF; break;
        default: decoded[i] = raw[i];
      }
    }

    for (let x = 0; x < width; x++) {
      const si = x * bpp, di = (y * width + x) * 4;
      out[di]     = decoded[si];
      out[di + 1] = decoded[si + 1];
      out[di + 2] = decoded[si + 2];
      out[di + 3] = bpp === 4 ? decoded[si + 3] : 255;
    }
    decoded.copy(prevRow);
  }
  return out;
}

/**
 * Decode an indexed-colour (palette) PNG to flat RGBA pixels.
 * plte — PLTE chunk data (3 bytes per palette entry, RGB)
 * trns — tRNS chunk data (1 alpha byte per entry, may be shorter than palette)
 */
function decodePalettePng(inflated, width, height, plte, trns) {
  const stride  = 1 + width;   // 1 filter byte + 1 index byte per pixel
  const out     = Buffer.alloc(width * height * 4);
  const prevRow = Buffer.alloc(width);

  for (let y = 0; y < height; y++) {
    const filterByte = inflated[y * stride];
    const raw        = inflated.slice(y * stride + 1, (y + 1) * stride);
    const decoded    = Buffer.alloc(width);

    for (let i = 0; i < raw.length; i++) {
      const a = i >= 1 ? decoded[i - 1] : 0;
      const b = prevRow[i];
      const c = i >= 1 ? prevRow[i - 1] : 0;
      switch (filterByte) {
        case 0: decoded[i] = raw[i]; break;
        case 1: decoded[i] = (raw[i] + a) & 0xFF; break;
        case 2: decoded[i] = (raw[i] + b) & 0xFF; break;
        case 3: decoded[i] = (raw[i] + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: decoded[i] = (raw[i] + paethPredictor(a, b, c)) & 0xFF; break;
        default: decoded[i] = raw[i];
      }
    }

    for (let x = 0; x < width; x++) {
      const idx = decoded[x];
      const di  = (y * width + x) * 4;
      out[di]     = plte[idx * 3];
      out[di + 1] = plte[idx * 3 + 1];
      out[di + 2] = plte[idx * 3 + 2];
      out[di + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
    }
    decoded.copy(prevRow);
  }
  return out;
}

/** Encode flat RGBA pixel buffer to PNG (filter type 0 per row). */
function encodePngRgba(pixels, width, height) {
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    pixels.copy(row, 1, y * width * 4, (y + 1) * width * 4);
    rawRows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rawRows), { level: 6 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Parse a PNG buffer, zero-out alpha on all pixels that don't match targetRgb
 * within tolerance, and return a new RGBA PNG buffer.
 * Supports colorType 2 (RGB), 3 (Palette), and 6 (RGBA).
 */
function filterNlcdPng(pngBuf, targetRgb, tolerance) {
  let offset = 8;
  let ihdr = null;
  let plte = null;
  let trns = null;
  const idatBufs = [];

  while (offset < pngBuf.length - 4) {
    const len  = pngBuf.readUInt32BE(offset);
    const type = pngBuf.slice(offset + 4, offset + 8).toString('ascii');
    const data = pngBuf.slice(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if      (type === 'IHDR') { ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType: data[9] }; }
    else if (type === 'PLTE') { plte = data; }
    else if (type === 'tRNS') { trns = data; }
    else if (type === 'IDAT') { idatBufs.push(data); }
  }

  if (!ihdr) throw new Error('No IHDR chunk found');
  const { width, height, colorType } = ihdr;
  const inflated = zlib.inflateSync(Buffer.concat(idatBufs));

  let pixels;
  if (colorType === 3) {
    if (!plte) throw new Error('No PLTE chunk for indexed PNG');
    pixels = decodePalettePng(inflated, width, height, plte, trns);
  } else if (colorType === 2 || colorType === 6) {
    pixels = decodePng(inflated, width, height, colorType === 6 ? 4 : 3);
  } else {
    throw new Error(`Unsupported PNG colorType ${colorType}`);
  }

  const [tr, tg, tb] = targetRgb;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i]     - tr) > tolerance ||
        Math.abs(pixels[i + 1] - tg) > tolerance ||
        Math.abs(pixels[i + 2] - tb) > tolerance) {
      // Zero all 4 bytes — fully transparent AND improves PNG compression
      pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
    }
  }

  return encodePngRgba(pixels, width, height);
}

/** Convert a tile z/x/y address to a EPSG:3857 BBOX string. */
function tileToBbox3857(z, x, y) {
  const R = 6378137, origin = -Math.PI * R;
  const tileM = 2 * Math.PI * R / Math.pow(2, z);
  const minx = origin + x * tileM,      maxx = origin + (x + 1) * tileM;
  const maxy = -(origin + y * tileM),   miny = -(origin + (y + 1) * tileM);
  return `${minx},${miny},${maxx},${maxy}`;
}

/**
 * Fetch a full NLCD WMS tile, filter it to a single class, and write the
 * resulting PNG to the HTTP response.
 */
function proxyNlcdTile(code, z, x, y, res) {
  const targetRgb = NLCD_COLORS[code];
  if (!targetRgb) { res.writeHead(400); res.end('Unknown NLCD code'); return; }

  const bbox = tileToBbox3857(z, x, y);
  const wmsPath =
    '/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/ows' +
    '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
    '&LAYERS=NLCD_2021_Land_Cover_L48' +
    '&FORMAT=image%2Fpng&TRANSPARENT=TRUE' +
    '&CRS=EPSG%3A3857&STYLES=&WIDTH=256&HEIGHT=256' +
    '&BBOX=' + bbox;

  https.get({ hostname: 'www.mrlc.gov', path: wmsPath, timeout: 15000 }, upstream => {
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      if (upstream.statusCode !== 200) {
        res.writeHead(502); res.end(`WMS ${upstream.statusCode}`); return;
      }
      try {
        const filtered = filterNlcdPng(Buffer.concat(chunks), targetRgb, 20);
        res.writeHead(200, {
          'Content-Type':                'image/png',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'public, max-age=86400',
        });
        res.end(filtered);
      } catch (err) {
        res.writeHead(500); res.end('PNG filter error: ' + err.message);
      }
    });
  }).on('error', err => { res.writeHead(502); res.end(err.message); });
}

// ── Agricultural fringe heatmap (NLCD-based) ─────────────────────────────────
// Fetches NLCD 2021 WMS tiles at z=10 covering the Green Bay 15 km radius,
// decodes the palette PNG, and emits a heatmap point for every pixel that
// maps to NLCD code 81 (Pasture/Hay) or 82 (Cultivated Crops).
//
// This reuses the proven MRLC WMS infrastructure (same source as the
// per-class NLCD overlays).  The raw unfiltered full-layer tile is fetched,
// then each pixel's palette entry is matched against NLCD_COLORS.
//
// Cached for 24 h.  Sampling stride 8 px ≈ 19 m spacing at z=10.

// Tile grid at z=10 covering Green Bay center (~[-88.013, 44.513]), r=15 km.
const FRINGE_Z     = 10;
const FRINGE_TILES = [];
for (let tx = 260; tx <= 262; tx++)
  for (let ty = 369; ty <= 371; ty++)
    FRINGE_TILES.push([tx, ty]);

// NLCD agricultural codes to include in the fringe heatmap, with weights.
//   82 Cultivated Crops — row/field crops adjacent to the corridor
//   81 Pasture/Hay      — may include alfalfa and clover
const FRINGE_NLCD_WEIGHTS = { 81: 0.55, 82: 1.0 };

/**
 * Build a Map from PLTE palette index → NLCD code by matching each PLTE
 * RGB triple against the verified NLCD_COLORS table (±20 tolerance).
 * Only entries matching a code in FRINGE_NLCD_WEIGHTS are included.
 */
function buildFringePaletteMap(plte) {
  const map = new Map();
  const TOL = 20;
  const entryCount = plte.length / 3;
  for (let i = 0; i < entryCount; i++) {
    const r = plte[i * 3], g = plte[i * 3 + 1], b = plte[i * 3 + 2];
    for (const [codeStr, [tr, tg, tb]] of Object.entries(NLCD_COLORS)) {
      if (Math.abs(r - tr) <= TOL && Math.abs(g - tg) <= TOL && Math.abs(b - tb) <= TOL) {
        const code = Number(codeStr);
        if (FRINGE_NLCD_WEIGHTS[code] !== undefined) map.set(i, code);
        break;
      }
    }
  }
  return map;
}

/** Decode a palette PNG to raw indices (one byte per pixel). */
function decodePaletteToIndices(inflated, width, height) {
  const stride  = 1 + width;
  const out     = new Uint8Array(width * height);
  const prevRow = Buffer.alloc(width);
  for (let y = 0; y < height; y++) {
    const filterByte = inflated[y * stride];
    const raw        = inflated.slice(y * stride + 1, (y + 1) * stride);
    const decoded    = Buffer.alloc(width);
    for (let i = 0; i < raw.length; i++) {
      const a = i >= 1 ? decoded[i - 1] : 0;
      const b = prevRow[i];
      const c = i >= 1 ? prevRow[i - 1] : 0;
      switch (filterByte) {
        case 0: decoded[i] = raw[i]; break;
        case 1: decoded[i] = (raw[i] + a) & 0xFF; break;
        case 2: decoded[i] = (raw[i] + b) & 0xFF; break;
        case 3: decoded[i] = (raw[i] + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: decoded[i] = (raw[i] + paethPredictor(a, b, c)) & 0xFF; break;
        default: decoded[i] = raw[i];
      }
    }
    for (let x = 0; x < width; x++) out[y * width + x] = decoded[x];
    decoded.copy(prevRow);
  }
  return out;
}

/** Convert a slippy-map tile pixel offset to WGS 84 [lng, lat]. */
function pixelToLngLat(z, tx, ty, px, py) {
  const n      = Math.pow(2, z);
  const lng    = (tx + px / 256) / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + py / 256) / n)));
  return [+(lng.toFixed(5)), +(latRad * 180 / Math.PI).toFixed(5)];
}

/** Fetch a remote HTTPS URL and return the body as a Buffer. */
function httpsGetBuf(hostname, path) {
  return new Promise((resolve, reject) => {
    https.get(
      { hostname, path, timeout: 15000, headers: { 'User-Agent': 'habitat-map/1.0' } },
      r => {
        if (r.statusCode !== 200) { r.resume(); reject(new Error(`HTTP ${r.statusCode}`)); return; }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      }
    ).on('error', reject);
  });
}

let cdlFringeCache     = null;
let cdlFringeCacheTime = 0;

async function computeCdlFringe() {
  const STRIDE = 8;  // sample every 8th pixel ≈ ~19 m per point at z=10
  const NLCD_WMS_HOST = 'www.mrlc.gov';
  const results = await Promise.allSettled(
    FRINGE_TILES.map(([tx, ty]) => {
      const bbox = tileToBbox3857(FRINGE_Z, tx, ty);
      const wmsPath =
        '/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/ows' +
        '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
        '&LAYERS=NLCD_2021_Land_Cover_L48' +
        '&FORMAT=image%2Fpng&TRANSPARENT=TRUE' +
        '&CRS=EPSG%3A3857&STYLES=&WIDTH=256&HEIGHT=256' +
        '&BBOX=' + bbox;
      return httpsGetBuf(NLCD_WMS_HOST, wmsPath).then(buf => ({ buf, tx, ty }));
    })
  );

  const features = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { buf, tx, ty } = result.value;

    let offset = 8, ihdr = null, plte = null;
    const idatBufs = [];
    while (offset < buf.length - 4) {
      const len  = buf.readUInt32BE(offset);
      const type = buf.slice(offset + 4, offset + 8).toString('ascii');
      const data = buf.slice(offset + 8, offset + 8 + len);
      offset += 12 + len;
      if      (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType: data[9] };
      else if (type === 'PLTE') plte = data;
      else if (type === 'IDAT') idatBufs.push(data);
    }
    if (!ihdr || ihdr.colorType !== 3 || !plte || idatBufs.length === 0) continue;

    let inflated;
    try { inflated = zlib.inflateSync(Buffer.concat(idatBufs)); } catch { continue; }

    const paletteMap = buildFringePaletteMap(plte);
    if (paletteMap.size === 0) continue;   // no agricultural entries in this tile

    const indices = decodePaletteToIndices(inflated, ihdr.width, ihdr.height);
    for (let py = 0; py < ihdr.height; py += STRIDE) {
      for (let px = 0; px < ihdr.width; px += STRIDE) {
        const idx    = indices[py * ihdr.width + px];
        const code   = paletteMap.get(idx);
        if (code === undefined) continue;
        const weight = FRINGE_NLCD_WEIGHTS[code];
        const [lng, lat] = pixelToLngLat(FRINGE_Z, tx, ty, px, py);
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: { weight },
        });
      }
    }
  }
  return features;
}

async function proxyCdlFringe(res) {
  const now = Date.now();
  if (cdlFringeCache && now - cdlFringeCacheTime < 24 * 60 * 60 * 1000) {
    res.writeHead(200, { 'Content-Type': 'application/json',
                         'Access-Control-Allow-Origin': '*',
                         'Cache-Control': 'public, max-age=86400' });
    res.end(cdlFringeCache);
    return;
  }
  try {
    const features    = await computeCdlFringe();
    cdlFringeCache     = JSON.stringify({ type: 'FeatureCollection', features });
    cdlFringeCacheTime = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json',
                         'Access-Control-Allow-Origin': '*',
                         'Cache-Control': 'public, max-age=86400' });
    res.end(cdlFringeCache);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── USDA NASS QuickStats proxy ────────────────────────────────────────────────
// Provides Wisconsin managed honey-bee colony counts and Brown County crop
// census data that sharpen the pollinator mismatch alert.
//
// Requires a free API key from https://quickstats.nass.usda.gov/api
//   Option A: NASS_API_KEY=your_key node serve.js
//   Option B: create ./nass-key.txt containing only your key
// Without a key the endpoint returns { available:false } and the app falls back
// to CDL-only analysis.

function getNassApiKey() {
  if (process.env.NASS_API_KEY) return process.env.NASS_API_KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, 'nass-key.txt'), 'utf8').trim(); }
  catch { return ''; }
}

function nassGet(params, cb) {
  const apiKey = getNassApiKey();
  if (!apiKey) { cb(null, null); return; }
  const qs = Object.entries({ key: apiKey, format: 'JSON', ...params })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const reqPath = '/api/api_GET/?' + qs;
  https.get(
    { hostname: 'quickstats.nass.usda.gov', path: reqPath, timeout: 15000,
      headers: { 'User-Agent': 'habitat-map/1.0' } },
    r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { cb(null, JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { cb(e, null); }
      });
    }
  ).on('error', e => cb(e, null));
}

function parseNassValue(str) {
  if (!str) return null;
  const t = str.trim();
  if (!t || t.startsWith('(')) return null;   // (D) withheld, (Z) near-zero, (NA)
  const n = parseInt(t.replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

function combineNassData(coloniesData, cropsData) {
  const result = { available: true, colonies: null, coloniesYear: null,
                   notableAcres: {}, totalNotableAcres: 0 };

  // Extract most recent non-suppressed colony count (take highest value per year
  // to get the all-practices total rather than an organic/conventional subset).
  if (coloniesData?.data?.length) {
    const byYear = {};
    for (const r of coloniesData.data) {
      const v = parseNassValue(r.Value);
      if (v === null) continue;
      const yr = Number(r.year);
      if (!byYear[yr] || v > byYear[yr]) byYear[yr] = v;
    }
    const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
    if (years.length) {
      result.colonies     = byYear[years[0]];
      result.coloniesYear = years[0];
    }
  }

  // Extract bee-dependent crop acres for Brown County (Census 2022).
  // Use only domain_desc=TOTAL rows to avoid double-counting.
  const BEE_KEYWORDS = ['ALFALFA', 'CLOVER', 'CUCUMBERS', 'SQUASH', 'PUMPKINS',
                        'CRANBERRIES', 'BLUEBERRIES', 'APPLES', 'CHERRIES'];
  if (cropsData?.data?.length) {
    for (const row of cropsData.data) {
      if (row.domain_desc !== 'TOTAL') continue;
      const v = parseNassValue(row.Value);
      if (!v) continue;
      const commodity = (row.commodity_desc || '').toUpperCase();
      for (const kw of BEE_KEYWORDS) {
        if (commodity.includes(kw)) {
          result.notableAcres[row.commodity_desc] =
            (result.notableAcres[row.commodity_desc] || 0) + v;
          break;
        }
      }
    }
  }
  result.totalNotableAcres = Object.values(result.notableAcres).reduce((s, v) => s + v, 0);
  return result;
}

let nassCache    = null;
let nassCacheTime = 0;

function proxyQuickStats(res) {
  if (!getNassApiKey()) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      available: false,
      reason: 'No NASS API key. Register free at https://quickstats.nass.usda.gov/api ' +
              'then set NASS_API_KEY env var or create ./nass-key.txt',
    }));
    return;
  }

  const now = Date.now();
  if (nassCache && now - nassCacheTime < 24 * 60 * 60 * 1000) {
    res.writeHead(200, { 'Content-Type': 'application/json',
                         'Access-Control-Allow-Origin': '*',
                         'Cache-Control': 'public, max-age=86400' });
    res.end(nassCache);
    return;
  }

  let pending = 2, coloniesData = null, cropsData = null;
  function finish() {
    const combined = combineNassData(coloniesData, cropsData);
    nassCache     = JSON.stringify(combined);
    nassCacheTime = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json',
                         'Access-Control-Allow-Origin': '*',
                         'Cache-Control': 'public, max-age=86400' });
    res.end(nassCache);
  }

  // Query 1: Wisconsin managed honey-bee colony inventory (SURVEY, recent years)
  nassGet({
    source_desc:      'SURVEY',
    commodity_desc:   'HONEY',
    statisticcat_desc:'COLONIES',
    agg_level_desc:   'STATE',
    state_fips_code:  '55',
    year__GE:         '2018',
  }, (err, data) => { if (!err) coloniesData = data; if (--pending === 0) finish(); });

  // Query 2: Brown County bee-dependent crop area harvested (Census 2022)
  nassGet({
    source_desc:      'CENSUS',
    year:             '2022',
    state_fips_code:  '55',
    county_code:      '009',
    statisticcat_desc:'AREA HARVESTED',
    agg_level_desc:   'COUNTY',
  }, (err, data) => { if (!err) cropsData = data; if (--pending === 0) finish(); });
}

// ──────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // Proxy: HNP guest API (no CORS headers on their server)
  if (pathname === '/api/hnp-plantings') {
    proxyHnp(res);
    return;
  }

  // Proxy: USDA NASS CDL county statistics (no CORS headers on their server)
  if (pathname === '/api/cdl-stats') {
    proxyCdlStats(res);
    return;
  }

  // Proxy: CDL agricultural fringe heatmap points
  if (pathname === '/api/cdl-fringe') {
    proxyCdlFringe(res);
    return;
  }

  // Proxy: USDA NASS QuickStats (colonies + county crops)
  if (pathname === '/api/quickstats') {
    proxyQuickStats(res);
    return;
  }

  // Proxy: NLCD per-class filtered tile
  const nlcdMatch = pathname.match(/^\/api\/nlcd-tile\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/);
  if (nlcdMatch) {
    const [, codeStr, zStr, xStr, yStr] = nlcdMatch;
    proxyNlcdTile(Number(codeStr), Number(zStr), Number(xStr), Number(yStr), res);
    return;
  }

  // Normalise: treat / as /index.html
  const relative = pathname === '/' ? '/index.html' : pathname;

  // Prevent directory traversal
  const filePath = path.join(ROOT, path.normalize(relative));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT}`);
  console.log(`Open → http://localhost:${PORT}`);
});
