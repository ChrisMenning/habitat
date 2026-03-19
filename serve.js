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

// ── Centralised API key loader ────────────────────────────────────────────────
// All credentials live in a single ./api-keys.txt file (gitignored).
// Format: one KEY=value per line; lines starting with # are ignored.
// Environment variables always take precedence over the file.
//
// Supported keys:
//   NASS_API_KEY  — USDA NASS QuickStats  https://quickstats.nass.usda.gov/api
//   EBIRD_API_KEY — Cornell eBird         https://ebird.org/api/keygen
//   NOAA_CDO_TOKEN — NOAA CDO / NCEI      https://www.ncdc.noaa.gov/cdo-web/token
//
// Legacy single-key files (nass-key.txt, ebird-key.txt, noaa-token.txt) are
// still read as a last resort so existing setups keep working without changes.

let _apiKeys = null;
function loadApiKeys() {
  if (_apiKeys) return _apiKeys;
  _apiKeys = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'api-keys.txt'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && val) _apiKeys[key] = val;
    }
  } catch { /* file absent — env vars or legacy files will be used */ }
  return _apiKeys;
}

function getApiKey(envName, legacyFile) {
  if (process.env[envName]) return process.env[envName].trim();
  const keys = loadApiKeys();
  if (keys[envName]) return keys[envName];
  try { return fs.readFileSync(path.join(ROOT, legacyFile), 'utf8').trim(); }
  catch { return ''; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
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
      // Step 2: fetch the actual JSON data file.
      // NB: CropScape returns JS object literal syntax with unquoted keys
      // (e.g. {success:true, rows:[...]}) which is not valid JSON.
      // We buffer the response and quote bare identifier keys before forwarding.
      https.get(match[1], { timeout: 15000 }, jsonRes => {
        let raw = '';
        jsonRes.on('data', chunk => { raw += chunk; });
        jsonRes.on('end', () => {
          // Quote unquoted object keys:  {foo:  →  {"foo":
          const fixed = raw.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
          res.writeHead(jsonRes.statusCode, {
            'Content-Type':                'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control':               'public, max-age=86400',  // 24 h
          });
          res.end(fixed);
        });
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
// ── NLCD nesting suitability score batch ─────────────────────────────────────
// Accepts /api/nlcd-nesting?sites=JSON_ARRAY where each element is {id,lng,lat}.
// For each site fetches NLCD tiles at z=13, counts pixels of classes 31/52/71
// within a 300m radius, and returns a 0–100 nesting suitability score.
//
// Nesting weights:
//   31  Barren Land         — bare soil/sand, prime ground-nesting substrate  (weight 3)
//   52  Shrub/Scrub         — stem-nesting; also ground-nesting               (weight 2)
//   71  Grassland/Herbaceous — ground-nesting bees                            (weight 3)

const NESTING_CODES   = { 31: 3, 52: 2, 71: 3 };
const NESTING_Z       = 13;
const NESTING_RADIUS  = 300; // metres
const NESTING_TTL     = 24 * 60 * 60 * 1000; // 24 h tile cache

const _nestingTileCache    = new Map(); // key → { palMap, indices, width, height }
const _nestingTileCacheAge = new Map(); // key → timestamp

/** Convert [lng, lat] to slippy tile [tx, ty] at zoom z. */
function _lngLatToTile(z, lng, lat) {
  const n     = Math.pow(2, z);
  const tx    = Math.floor((lng + 180) / 360 * n);
  const latR  = lat * Math.PI / 180;
  const ty    = Math.floor(
    (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n
  );
  return [tx, ty];
}

/** All tiles whose bounding box intersects a 300m circle around [lng, lat]. */
function _tilesForRadius(z, lng, lat, radiusM) {
  const dLng = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const dLat = radiusM / 111320;
  const [txL]  = _lngLatToTile(z, lng - dLng, lat);
  const [txR]  = _lngLatToTile(z, lng + dLng, lat);
  const [, tyT] = _lngLatToTile(z, lng, lat + dLat);
  const [, tyB] = _lngLatToTile(z, lng, lat - dLat);
  const tiles = [];
  for (let tx = txL; tx <= txR; tx++)
    for (let ty = tyT; ty <= tyB; ty++)
      tiles.push([tx, ty]);
  return tiles;
}

/** Build a palette-index → NLCD code map for only the nesting classes. */
function _buildNestingPaletteMap(plte) {
  const map = new Map();
  const TOL = 20;
  const count = plte.length / 3;
  for (let i = 0; i < count; i++) {
    const r = plte[i * 3], g = plte[i * 3 + 1], b = plte[i * 3 + 2];
    for (const [codeStr, [tr, tg, tb]] of Object.entries(NLCD_COLORS)) {
      const code = Number(codeStr);
      if (NESTING_CODES[code] === undefined) continue;
      if (Math.abs(r - tr) <= TOL && Math.abs(g - tg) <= TOL && Math.abs(b - tb) <= TOL) {
        map.set(i, code);
        break;
      }
    }
  }
  return map;
}

/**
 * Fetch and decode an NLCD WMS tile at zoom z.
 * Returns { palMap, indices, width, height } or null on error.
 * Results are cached for 24 h.
 */
async function _getNlcdTileData(z, tx, ty) {
  const key = `${z}/${tx}/${ty}`;
  const now = Date.now();
  if (_nestingTileCache.has(key) && now - _nestingTileCacheAge.get(key) < NESTING_TTL) {
    return _nestingTileCache.get(key);
  }
  const bbox = tileToBbox3857(z, tx, ty);
  let buf;
  try {
    buf = await httpsGetBuf('www.mrlc.gov',
      '/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/ows' +
      '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap' +
      '&LAYERS=NLCD_2021_Land_Cover_L48' +
      '&FORMAT=image%2Fpng&TRANSPARENT=TRUE' +
      '&CRS=EPSG%3A3857&STYLES=&WIDTH=256&HEIGHT=256' +
      '&BBOX=' + bbox);
  } catch { return null; }

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
  if (!ihdr || ihdr.colorType !== 3 || !plte || idatBufs.length === 0) return null;
  let inflated;
  try { inflated = zlib.inflateSync(Buffer.concat(idatBufs)); } catch { return null; }
  const indices = decodePaletteToIndices(inflated, ihdr.width, ihdr.height);
  const palMap  = _buildNestingPaletteMap(plte);
  const result  = { palMap, indices, width: ihdr.width, height: ihdr.height };
  _nestingTileCache.set(key, result);
  _nestingTileCacheAge.set(key, now);
  return result;
}

/**
 * Count nesting-class pixels within radiusM of [lng, lat] in a single decoded tile.
 * Returns { counts: {31:N,52:N,71:N}, total: N }.
 */
function _countNestingPixels(tile, z, tx, ty, lng, lat, radiusM) {
  const { palMap, indices, width, height } = tile;
  const counts = { 31: 0, 52: 0, 71: 0 };
  let total = 0;
  const latR    = lat * Math.PI / 180;
  const cosLat  = Math.cos(latR);
  // Convert radiusM to approximate degree offsets for bounding-box pre-filter
  const dLng = radiusM / (111320 * cosLat);
  const dLat = radiusM / 111320;
  // Fractional pixel coords of the site in this tile
  const n    = Math.pow(2, z);
  const fpx  = ((lng + 180) / 360 * n - tx) * 256;
  const fpyNum = Math.log(Math.tan(latR) + 1 / Math.cos(latR));
  const fpy  = ((1 - fpyNum / Math.PI) / 2 * n - ty) * 256;
  // Pixel radius bounds (approximate using longitude-scale for x, latitude-scale for y)
  const rpx  = dLng / (360 / (256 * n));
  const rpy  = dLat / (1 / (256 * n));  // rough — good enough for 300m
  const pxLo = Math.max(0,         Math.floor(fpx - rpx));
  const pxHi = Math.min(width - 1, Math.ceil(fpx + rpx));
  const pyLo = Math.max(0,         Math.floor(fpy - rpy));
  const pyHi = Math.min(height - 1, Math.ceil(fpy + rpy));

  for (let py = pyLo; py <= pyHi; py++) {
    for (let px = pxLo; px <= pxHi; px++) {
      // Convert pixel to WGS 84 and check distance (equirectangular approximation)
      const [pLng, pLat] = pixelToLngLat(z, tx, ty, px, py);
      const dx = (pLng - lng) * cosLat * 111320;
      const dy = (pLat - lat) * 111320;
      if (dx * dx + dy * dy > radiusM * radiusM) continue;
      total++;
      const code = palMap.get(indices[py * width + px]);
      if (code !== undefined) counts[code] = (counts[code] || 0) + 1;
    }
  }
  return { counts, total };
}

/**
 * Convert raw pixel counts to a 0–100 nesting score.
 * Scaling: 20% weighted-coverage → 100 points.
 */
function _nestingRawToScore(counts, total) {
  if (!total) return 0;
  const raw = (counts[31] || 0) * 3 + (counts[52] || 0) * 2 + (counts[71] || 0) * 3;
  // raw / (total * 3) = weighted proportion; × 500 scales so 20% → 100
  return Math.min(100, Math.round(raw / (total * 3) * 500));
}

/** Compute nesting scores for a batch of {id, lng, lat} sites. */
async function _computeNestingBatch(sites) {
  // Collect all unique tiles needed
  const tileKeys = new Map(); // 'z/tx/ty' → [tx, ty]
  for (const s of sites) {
    for (const [tx, ty] of _tilesForRadius(NESTING_Z, s.lng, s.lat, NESTING_RADIUS)) {
      const k = `${NESTING_Z}/${tx}/${ty}`;
      if (!tileKeys.has(k)) tileKeys.set(k, [tx, ty]);
    }
  }
  // Fetch all unique tiles in parallel
  const fetched = new Map();
  await Promise.allSettled(
    [...tileKeys.entries()].map(async ([k, [tx, ty]]) => {
      const data = await _getNlcdTileData(NESTING_Z, tx, ty);
      if (data) fetched.set(k, { data, tx, ty });
    })
  );
  // Score each site
  return sites.map(s => {
    const aggCounts = { 31: 0, 52: 0, 71: 0 };
    let aggTotal = 0;
    for (const [tx, ty] of _tilesForRadius(NESTING_Z, s.lng, s.lat, NESTING_RADIUS)) {
      const k = `${NESTING_Z}/${tx}/${ty}`;
      const t = fetched.get(k);
      if (!t) continue;
      const { counts, total } = _countNestingPixels(t.data, NESTING_Z, tx, ty, s.lng, s.lat, NESTING_RADIUS);
      aggCounts[31] += counts[31] || 0;
      aggCounts[52] += counts[52] || 0;
      aggCounts[71] += counts[71] || 0;
      aggTotal += total;
    }
    const score = _nestingRawToScore(aggCounts, aggTotal);
    return { id: s.id, score, counts: aggCounts, total: aggTotal };
  });
}

async function proxyNlcdNesting(req, res) {
  const parsed = url.parse(req.url, true);
  let sites;
  try {
    const raw = parsed.query.sites;
    if (!raw) throw new Error('missing sites');
    sites = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(sites) || sites.some(s => typeof s.lng !== 'number' || typeof s.lat !== 'number')) {
      throw new Error('invalid sites array');
    }
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  // Limit batch size to prevent abuse
  if (sites.length > 200) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'batch too large (max 200 sites)' }));
    return;
  }
  try {
    const results = await _computeNestingBatch(sites);
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=86400',
    });
    res.end(JSON.stringify(results));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ── Brown County parcel ownership proxy ──────────────────────────────────────
// Brown County, WI publishes parcel data through their ArcGIS REST Feature
// Service.  The server does not send CORS headers so requests must be proxied.
//
// Endpoint:
//   https://gis.co.brown.wi.us/arcgis/rest/services/OpenData/Parcels_Public_View/FeatureServer/0/query
//
// Called with ?bbox=minX,minY,maxX,maxY (WGS 84) from the client.
// Returns up to 2000 features as GeoJSON.  Cached in memory for 24 h.
//
// Brown County assessment schema field assumptions:
//   OWNNAME / OWN1        — owner name
//   PARCELID / PARCELNO   — parcel identifier
//   SITUSADDR / SITEADDR  — site address
//   CALCACRES / ACRES     — acreage
//   PROPCLASS / CLASS_CD  — property class code

const PARCEL_BASE_URL =
  'https://gis.browncountywi.gov/arcgis/rest/services/ParcelAndAddressFeatures/FeatureServer/23/query';

// ── Parcel tile grid ──────────────────────────────────────────────────────────
// Brown County is tiled into a fixed 0.02° × 0.02° grid aligned to these
// origin coordinates.  Both the server warmer and the browser client use the
// same grid so every browser request is a guaranteed cache hit after warmup.
//
// Grid extents:  lng -88.20 → -87.80  (20 columns)
//                lat  44.40 →  44.70  (15 rows)
// Total tiles: 300
// Warmup time: 300 × 2.5 s ≈ 12.5 min (runs silently in the background)

const PARCEL_TILE_DEG  = 0.02;
const PARCEL_TILE_COLS = 20;                    // columns (lng axis)
const PARCEL_TILE_ROWS = 15;                    // rows    (lat axis)
const PARCEL_TILE_ORIG_LNG = -88.20;
const PARCEL_TILE_ORIG_LAT =  44.40;
const PARCEL_TILE_TTL_MS   = 24 * 60 * 60 * 1000;

// Cache: key = "xi,yi" (integer tile indices)
const _parcelTileCache = new Map(); // key → { body: string, age: number }

/** Return the [west, south, east, north] bbox for grid tile (xi, yi). */
function _tileBbox(xi, yi) {
  const w = +(PARCEL_TILE_ORIG_LNG + xi * PARCEL_TILE_DEG).toFixed(6);
  const s = +(PARCEL_TILE_ORIG_LAT + yi * PARCEL_TILE_DEG).toFixed(6);
  const e = +(w + PARCEL_TILE_DEG).toFixed(6);
  const n = +(s + PARCEL_TILE_DEG).toFixed(6);
  return [w, s, e, n];
}

// Layer 26 (GCS_Parcel) is a non-spatial table with owner name fields.
// Join key: layer 23 PARCELID = layer 26 ParcelNumber.
// Confidential=1 records are excluded (privacy protection).
const PARCEL_OWNER_BASE_URL = 'https://gis.browncountywi.gov/arcgis/rest/services/ParcelAndAddressFeatures/FeatureServer/26/query';

/**
 * Build a display-ready owner name from a layer-26 attributes object.
 * Names are stored ALL-CAPS; we convert to title case.
 * Corporate / LLC names are typically stored entirely in LastName1.
 */
function _buildOwnerName(attrs) {
  const tc  = s => String(s || '').trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  const str = s => String(s || '').trim();

  const last1  = tc(attrs.LastName1      || '');
  const ext1   = tc(attrs.NameExtension1 || '');
  const first1 = tc(attrs.FirstName1     || '');
  const mid1   = tc(attrs.MiddleName1    || '');

  if (last1) {
    const ext = ext1 ? ` ${ext1}` : '';
    if (first1) return `${last1}${ext}, ${first1}${mid1 ? ' ' + mid1 : ''}`;
    return `${last1}${ext}`;
  }

  // Attention line — trusts, LLCs, c/o names stored here when LastName1 is empty
  const attn = tc(str(attrs.Attention));
  if (attn) return attn;

  // Co-owner fallback
  const last2  = tc(attrs.LastName2  || '');
  const first2 = tc(attrs.FirstName2 || '');
  if (last2) return first2 ? `${last2}, ${first2}` : last2;

  return '';
}

/**
 * POST to layer 26 for the given PARCELID list and return a Map of
 * ParcelNumber → display owner name.  Records with Confidential=1 are omitted.
 */
function _fetchOwnerNames(parcelIds) {
  return new Promise((resolve, reject) => {
    if (!parcelIds.length) { resolve(new Map()); return; }
    // SQL IN clause — single-quote each id, escape any embedded single quotes
    const escaped = parcelIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(',');
    const body = new URLSearchParams({
      where:             `ParcelNumber IN (${escaped}) AND (Confidential IS NULL OR Confidential = 0)`,
      outFields:         'ParcelNumber,Attention,LastName1,FirstName1,MiddleName1,NameExtension1,LastName2,FirstName2',
      returnGeometry:    'false',
      f:                 'json',
      resultRecordCount: '2000',
    }).toString();

    const parsed = new URL(PARCEL_OWNER_BASE_URL);
    const req = https.request(
      { method: 'POST', hostname: parsed.hostname, path: parsed.pathname,
        timeout: 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(body),
                   'User-Agent': 'habitat-map/1.0' } },
      upstream => {
        const chunks = [];
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', () => {
          try {
            const j    = JSON.parse(Buffer.concat(chunks).toString());
            const map  = new Map();
            for (const rec of j.features ?? []) {
              const pn   = rec.attributes?.ParcelNumber;
              const name = _buildOwnerName(rec.attributes ?? {});
              if (pn && name) map.set(pn, name);
            }
            resolve(map);
          } catch (err) { reject(err); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('owner names timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Fetch a single grid tile from the county GIS server.
 * Two-step: geometry + classification from layer 23, owner names from layer 26.
 * Result is stored in _parcelTileCache keyed by "xi,yi".
 */
function _fetchParcelTile(xi, yi) {
  return new Promise((resolve, reject) => {
    const key = `${xi},${yi}`;
    const now = Date.now();
    const hit = _parcelTileCache.get(key);
    if (hit && now - hit.age < PARCEL_TILE_TTL_MS) { resolve(hit.body); return; }

    const [w, s, e, n] = _tileBbox(xi, yi);
    const bbox = `${w},${s},${e},${n}`;

    const params = new URLSearchParams({
      where:             '1=1',
      geometry:          bbox,
      geometryType:      'esriGeometryEnvelope',
      inSR:              '4326',
      spatialRel:        'esriSpatialRelIntersects',
      returnGeometry:    'true',
      outSR:             '4326',
      outFields:         'PARCELID,PublicOwner,Municipality,MapAreaTxt',
      f:                 'geojson',
      resultRecordCount: '2000',
    });

    const fullUrl = `${PARCEL_BASE_URL}?${params.toString()}`;
    const parsed  = new URL(fullUrl);

    const req = https.get(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
        timeout: 25000, headers: { 'User-Agent': 'habitat-map/1.0' } },
      upstream => {
        const chunks = [];
        upstream.on('data', c => chunks.push(c));
        upstream.on('end', async () => {
          if (upstream.statusCode !== 200) {
            reject(new Error(`Parcel upstream HTTP ${upstream.statusCode}`)); return;
          }
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let geojson;
          try {
            geojson = JSON.parse(rawBody);
            if (geojson.error) { reject(new Error(`ArcGIS ${geojson.error.code}: ${geojson.error.message}`)); return; }
          } catch (err) { reject(err); return; }

          // Step 2: fetch owner names from layer 26 and stamp onto features
          const parcelIds = (geojson.features ?? []).map(f => f.properties?.PARCELID).filter(Boolean);
          let ownerMap = new Map();
          try { ownerMap = await _fetchOwnerNames(parcelIds); }
          catch (err) { console.warn('[parcel-tile] owner names fetch failed:', err.message); }

          if (ownerMap.size) {
            geojson = {
              ...geojson,
              features: geojson.features.map(f => {
                const pid  = f.properties?.PARCELID;
                const name = pid ? (ownerMap.get(pid) ?? '') : '';
                if (!name) return f;
                return { ...f, properties: { ...f.properties, OwnerName: name } };
              }),
            };
          }

          const body = JSON.stringify(geojson);
          _parcelTileCache.set(key, { body, age: Date.now() });
          resolve(body);
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Handle GET /api/parcel-tile?xi=N&yi=N */
function proxyParcelTile(reqUrl, res) {
  const qs = url.parse(reqUrl, true).query;
  const xi = parseInt(qs.xi, 10);
  const yi = parseInt(qs.yi, 10);

  if (!Number.isFinite(xi) || !Number.isFinite(yi) ||
      xi < 0 || xi >= PARCEL_TILE_COLS || yi < 0 || yi >= PARCEL_TILE_ROWS) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'tile index out of range' }));
    return;
  }

  _fetchParcelTile(xi, yi)
    .then(body => {
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=86400',
      });
      res.end(body);
    })
    .catch(err => {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: err.message }));
    });
}

/**
 * Background cache warmer.  Iterates every grid tile in county-scan order
 * (row-by-row, roughly south→north) with a 2.5 s pause between tiles so
 * the county GIS server is not flooded.  Already-cached tiles are skipped.
 * Runs entirely in the background — errors are logged but do not crash.
 */
async function _warmParcelCache() {
  const total = PARCEL_TILE_COLS * PARCEL_TILE_ROWS;
  let warmed = 0;
  let skipped = 0;
  console.log(`[parcel-warm] starting — ${total} tiles, ~${Math.round(total * 2.5 / 60)} min`);

  for (let yi = 0; yi < PARCEL_TILE_ROWS; yi++) {
    for (let xi = 0; xi < PARCEL_TILE_COLS; xi++) {
      const key = `${xi},${yi}`;
      if (_parcelTileCache.has(key)) { skipped++; continue; }

      await new Promise(r => setTimeout(r, 2500));

      try {
        await _fetchParcelTile(xi, yi);
        warmed++;
        if (warmed % 20 === 0) {
          console.log(`[parcel-warm] ${warmed + skipped}/${total} (${warmed} fetched)`);
        }
      } catch (err) {
        console.warn(`[parcel-warm] tile ${xi},${yi} failed: ${err.message}`);
      }
    }
  }
  console.log(`[parcel-warm] complete — ${warmed} fetched, ${skipped} from cache`);
}

// Legacy bbox-based endpoint kept for any direct callers.
// For new code, prefer /api/parcel-tile?xi=N&yi=N
function proxyParcels(reqUrl, res) {
  const qs = url.parse(reqUrl, true).query;
  const [rawW, rawS, rawE, rawN] = (qs.bbox || '-88.07,44.47,-87.89,44.57').split(',').map(Number);
  // Find the grid tile whose centre is closest to the bbox centre and serve it.
  const cx  = (rawW + rawE) / 2;
  const cy  = (rawS + rawN) / 2;
  const xi  = Math.max(0, Math.min(PARCEL_TILE_COLS - 1,
    Math.floor((cx - PARCEL_TILE_ORIG_LNG) / PARCEL_TILE_DEG)));
  const yi  = Math.max(0, Math.min(PARCEL_TILE_ROWS - 1,
    Math.floor((cy - PARCEL_TILE_ORIG_LAT) / PARCEL_TILE_DEG)));
  proxyParcelTile(`?xi=${xi}&yi=${yi}`, res);
}

function proxyNlcdTile(code, z, x, y, res) {

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
  return getApiKey('NASS_API_KEY', 'nass-key.txt');
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

// ── NOAA GHCND daily-summaries proxy ─────────────────────────────────────────
// Proxies GET /api/noaa/ghcnd?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// → NCEI Access Data Service daily-summaries endpoint.
// Requires a free NOAA CDO token from https://www.ncdc.noaa.gov/cdo-web/token
// (the NCDC URL is correct and still active despite the old domain name).
//   Option A: NOAA_CDO_TOKEN=your_token node serve.js
//   Option B: create ./noaa-token.txt containing only your token
// Without a token the endpoint returns { available: false } and live GDD is skipped.

const NOAA_STATION_ID = 'USW00014898';  // Green Bay Austin Straubel Airport

function getNoaaToken() {
  return getApiKey('NOAA_CDO_TOKEN', 'noaa-token.txt');
}

// Server-side 12-hour cache so repeated browser loads don't hammer NOAA.
let _ghcndCache = { key: '', data: null, time: 0 };

function proxyNoaaGhcnd(reqUrl, res) {
  const token = getNoaaToken();
  if (!token) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      available: false,
      reason: 'No NOAA CDO token. Get a free one at https://www.ncdc.noaa.gov/cdo-web/token ' +
              'then set NOAA_CDO_TOKEN env var or create ./noaa-token.txt',
    }));
    return;
  }

  const qs        = url.parse(reqUrl, true).query ?? {};
  const year      = new Date().getFullYear();
  const startDate = qs.startDate ?? `${year}-01-01`;
  const endDate   = qs.endDate   ?? new Date().toISOString().slice(0, 10);
  const cacheKey  = `${startDate}-${endDate}`;

  if (_ghcndCache.key === cacheKey && _ghcndCache.data &&
      (Date.now() - _ghcndCache.time) < 12 * 60 * 60 * 1000) {
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=43200',
    });
    res.end(_ghcndCache.data);
    return;
  }

  const nceiPath =
    `/access/services/data/v1?dataset=daily-summaries` +
    `&stations=${NOAA_STATION_ID}` +
    `&startDate=${encodeURIComponent(startDate)}` +
    `&endDate=${encodeURIComponent(endDate)}` +
    `&dataTypes=TMAX,TMIN&format=json&units=standard`;

  https.get(
    {
      hostname: 'www.ncei.noaa.gov',
      path:     nceiPath,
      timeout:  20000,
      headers:  { token, 'User-Agent': 'habitat-map/1.0' },
    },
    upstream => {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        const body        = Buffer.concat(chunks);
        _ghcndCache       = { key: cacheKey, data: body, time: Date.now() };
        res.writeHead(200, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'public, max-age=43200',
        });
        res.end(body);
      });
    },
  ).on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
}

// ── eBird recent-observations proxy ─────────────────────────────────────────
// Proxies GET /api/ebird?back=N → Cornell eBird API /data/obs/geo/recent.
// Requires a free eBird API key from https://ebird.org/api/keygen
//   Option A: EBIRD_API_KEY=your_key node serve.js
//   Option B: add EBIRD_API_KEY=your_key to ./api-keys.txt
// Without a key the endpoint returns { available: false } and the layer is skipped.

function getEbirdApiKey() {
  return getApiKey('EBIRD_API_KEY', 'ebird-key.txt');
}

// Green Bay, WI center for the eBird geo/recent endpoint
const EBIRD_LAT = 44.5133;
const EBIRD_LNG = -88.0133;
const EBIRD_DIST_KM = 15;  // match RADIUS_KM from config.js

function proxyEbird(reqUrl, res) {
  const apiKey = getEbirdApiKey();
  if (!apiKey) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ available: false }));
    return;
  }
  const qs  = url.parse(reqUrl).query ?? '';
  const params = new URLSearchParams(qs);
  const back = Math.min(30, parseInt(params.get('back') ?? '30', 10)) || 30;
  const ebirdPath = `/v2/data/obs/geo/recent?lat=${EBIRD_LAT}&lng=${EBIRD_LNG}&dist=${EBIRD_DIST_KM}&back=${back}&fmt=json`;
  https.get(
    { hostname: 'api.ebird.org', path: ebirdPath, timeout: 15000,
      headers: { 'X-eBirdApiToken': apiKey, 'User-Agent': 'habitat-map/1.0' } },
    upstream => {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        res.writeHead(200, {
          'Content-Type':                'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control':               'public, max-age=1800',  // 30 min
        });
        res.end(Buffer.concat(chunks));
      });
    }
  ).on('error', err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
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

  // Proxy: eBird recent observations near Green Bay
  if (pathname === '/api/ebird') {
    proxyEbird(req.url, res);
    return;
  }

  // Proxy: NOAA GHCND daily-summaries (current-year TMAX/TMIN for GDD accumulation)
  if (pathname === '/api/noaa/ghcnd') {
    proxyNoaaGhcnd(req.url, res);
    return;
  }

  // Batch: NLCD nesting suitability scores for a set of corridor sites
  if (pathname === '/api/nlcd-nesting') {
    proxyNlcdNesting(req, res);
    return;
  }

  // Brown County parcel ownership data (GIS portal doesn't send CORS headers)
  if (pathname === '/api/parcel-tile') {
    proxyParcelTile(req.url, res);
    return;
  }
  if (pathname === '/api/parcels') {
    proxyParcels(req.url, res);
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
  // Pre-warm the parcel tile cache in the background.
  // 300 tiles × 2.5 s ≈ 12.5 min; already-cached tiles are skipped instantly.
  setTimeout(_warmParcelCache, 5000);
});
