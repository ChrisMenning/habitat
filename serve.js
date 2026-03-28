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

const PORT    = process.env.PORT || 3000;
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

// Green Bay region bbox (1.5× margin, matching hnp.js BBOX constants)
const HNP_BBOX = {
  minLat: 44.3112, maxLat: 44.7154,
  minLng: -88.2965, maxLng: -87.7301,
};

// Shared upstream cache — both /api/hnp-plantings and /api/hnp-count use this
// so a single upstream fetch per TTL window serves both endpoints.
let _hnpUpstreamCache    = null;  // raw plantings array
let _hnpUpstreamCacheAge = 0;
const _HNP_UPSTREAM_TTL  = 60 * 60 * 1000; // 1 hour

function _fetchHnpUpstream() {
  const now = Date.now();
  if (_hnpUpstreamCache && now - _hnpUpstreamCacheAge < _HNP_UPSTREAM_TTL) {
    return Promise.resolve(_hnpUpstreamCache);
  }
  return new Promise((resolve, reject) => {
    https.get(HNP_UPSTREAM, { timeout: 20000 }, upstream => {
      const chunks = [];
      upstream.on('data', c => chunks.push(c));
      upstream.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { reject(new Error('HNP API returned invalid JSON')); return; }
        if (!Array.isArray(parsed)) { reject(new Error('HNP API returned unexpected format')); return; }
        _hnpUpstreamCache    = parsed;
        _hnpUpstreamCacheAge = Date.now();
        resolve(parsed);
      });
    }).on('error', reject);
  });
}

function proxyHnp(res) {
  _fetchHnpUpstream().then(plantings => {
    const features = plantings
      .filter(p => p.latitude != null && p.longitude != null)
      .map(p => {
        // eslint-disable-next-line no-unused-vars
        const { latitude, longitude, ...rawProps } = p;
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
          properties: { ...rawProps, org_type: rawProps.type },
        };
      });
    const geojson = JSON.stringify({ type: 'FeatureCollection', features });
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    res.end(geojson);
  }).catch(err => {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  });
}

// Returns just the bbox-filtered count — lightweight for the marketing page.
function proxyHnpCount(res) {
  _fetchHnpUpstream().then(plantings => {
    const count = plantings.filter(p =>
      p.latitude  != null && p.longitude != null &&
      p.latitude  >= HNP_BBOX.minLat && p.latitude  <= HNP_BBOX.maxLat &&
      p.longitude >= HNP_BBOX.minLng && p.longitude <= HNP_BBOX.maxLng
    ).length;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' });
    res.end(JSON.stringify({ count }));
  }).catch(err => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
}

// ── CDL WMS ping ────────────────────────────────────────────────────────────
// Server-side HEAD to the CropScape WMS — nassgeodata.gmu.edu sends no CORS
// headers so a browser fetch would always be blocked; use this proxy instead.
const CDL_WMS_PING = 'https://nassgeodata.gmu.edu/arcgis/services/CDLService/MapServer/WMSServer?SERVICE=WMS&REQUEST=GetCapabilities';

function proxyCdlPing(res) {
  const req = https.request(CDL_WMS_PING, { method: 'HEAD', timeout: 10000 }, upstream => {
    res.writeHead(upstream.statusCode < 500 ? 200 : 502, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    res.end(JSON.stringify({ status: upstream.statusCode }));
    upstream.resume();
  });
  req.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  });
  req.on('timeout', () => { req.destroy(); });
  req.end();
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
//   11  Open Water          — tracked to detect water-dominant cells (excluded from score)
//   31  Barren Land         — bare soil/sand, prime ground-nesting substrate  (weight 7)
//                             ~70% of native bee species nest in bare/sparse ground
//   52  Shrub/Scrub         — stem-nesting; also ground-nesting               (weight 2)
//   71  Grassland/Herbaceous — ground-nesting bees                            (weight 3)

const NESTING_CODES   = { 31: 7, 52: 2, 71: 3 };
const TRACKED_CODES   = new Set([11, 21, 22, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95]);
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
      if (!TRACKED_CODES.has(code)) continue;
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
  _saveToDisk(
    path.join(_DISK_CACHE_DIR, 'nlcd-nesting', `${key.replace(/\//g, '_')}.json`),
    { palMap: [...result.palMap], indices: Buffer.from(result.indices).toString('base64'), width: result.width, height: result.height, age: now }
  );
  return result;
}

/**
 * Count nesting-class pixels within radiusM of [lng, lat] in a single decoded tile.
 * Returns { counts: {31:N,52:N,71:N}, total: N }.
 */
function _countNestingPixels(tile, z, tx, ty, lng, lat, radiusM) {
  const { palMap, indices, width, height } = tile;
  const counts = { 11: 0, 21: 0, 22: 0, 31: 0, 41: 0, 42: 0, 43: 0, 52: 0, 71: 0, 81: 0, 82: 0, 90: 0, 95: 0 };
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
  const raw = (counts[31] || 0) * 7 + (counts[52] || 0) * 2 + (counts[71] || 0) * 3;
  // raw / (total * 7) = weighted proportion; × 500 scales so 20% → 100
  return Math.min(100, Math.round(raw / (total * 7) * 500));
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
    const aggCounts = { 11: 0, 21: 0, 22: 0, 31: 0, 41: 0, 42: 0, 43: 0, 52: 0, 71: 0, 81: 0, 82: 0, 90: 0, 95: 0 };
    let aggTotal = 0;
    for (const [tx, ty] of _tilesForRadius(NESTING_Z, s.lng, s.lat, NESTING_RADIUS)) {
      const k = `${NESTING_Z}/${tx}/${ty}`;
      const t = fetched.get(k);
      if (!t) continue;
      const { counts, total } = _countNestingPixels(t.data, NESTING_Z, tx, ty, s.lng, s.lat, NESTING_RADIUS);
      for (const code of [11, 21, 22, 31, 41, 42, 43, 52, 71, 81, 82, 90, 95]) {
        aggCounts[code] += counts[code] || 0;
      }
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
  if (sites.length > 600) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'batch too large (max 600 sites)' }));
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

// ── WI DNR Urban Tree Canopy coverage batch ──────────────────────────────────
// Accepts /api/canopy-check?sites=JSON_ARRAY where each element is {id,lng,lat}.
// For each site fetches the 2022 WI DNR Urban Tree Canopy ImageServer via
// exportImage, applies a deterministic 2-class colormap rendering rule, decodes
// the PNG32 pixels, and returns canopy coverage as a 0–100 percentage.
//
// Colormap (ArcGIS Colormap raster function):
//   value 0  (non-tree) → rgb(100, 70, 20)  — brownish
//   value 1  (tree)     → rgb(0, 180, 0)    — bright green
//   value 255 (noData)  → transparent (masked by noData=255)
// This makes pixel classification deterministic regardless of server styling.

const CANOPY_HOST         = 'dnrmaps.wi.gov';
const CANOPY_PATH_BASE    = '/arcgis_image/rest/services/FR_URBAN_FORESTRY/FR_Urban_Tree_Canopy_Raster_2022/ImageServer/exportImage';
const CANOPY_RADIUS_M     = 150;
const CANOPY_TILE_SIZE    = 64;
const CANOPY_YEAR         = 2022;
const CANOPY_TTL          = 24 * 60 * 60 * 1000; // 24 h
const CANOPY_RENDERING_RULE = JSON.stringify({
  rasterFunction: 'Colormap',
  rasterFunctionArguments: { Colormap: [[0, 100, 70, 20], [1, 0, 180, 0]] },
});

const _canopyCache    = new Map(); // bbox key → { treeCount, total }
const _canopyCacheAge = new Map(); // bbox key → timestamp

/**
 * Fetch the tree canopy raster for a ~150m radius around a point and count
 * tree vs. non-tree pixels.
 * @returns {Promise<{ treeCount: number, total: number }>}
 */
async function _getCanopyPixels(lng, lat) {
  const dLng    = CANOPY_RADIUS_M / (111320 * Math.cos(lat * Math.PI / 180));
  const dLat    = CANOPY_RADIUS_M / 111320;
  const bboxStr = `${(lng - dLng).toFixed(6)},${(lat - dLat).toFixed(6)},${(lng + dLng).toFixed(6)},${(lat + dLat).toFixed(6)}`;
  const now = Date.now();
  if (_canopyCache.has(bboxStr) && now - _canopyCacheAge.get(bboxStr) < CANOPY_TTL) {
    return _canopyCache.get(bboxStr);
  }

  const qPath = CANOPY_PATH_BASE
    + '?bbox=' + bboxStr
    + '&bboxSR=4326&size=' + CANOPY_TILE_SIZE + ',' + CANOPY_TILE_SIZE
    + '&imageSR=4326&format=png32&noData=255&noDataInterpretation=esriNoDataMatchAny'
    + '&renderingRule=' + encodeURIComponent(CANOPY_RENDERING_RULE)
    + '&f=image';

  let buf;
  try { buf = await httpsGetBuf(CANOPY_HOST, qPath); }
  catch { return { treeCount: 0, total: 0 }; }

  // Parse PNG32 (colorType=6, RGBA)
  let offset = 8, ihdr = null;
  const idatBufs = [];
  while (offset < buf.length - 4) {
    const len  = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    const data = buf.slice(offset + 8, offset + 8 + len);
    offset += 12 + len;
    if      (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), colorType: data[9] };
    else if (type === 'IDAT') idatBufs.push(data);
  }
  if (!ihdr || ihdr.colorType !== 6 || idatBufs.length === 0) return { treeCount: 0, total: 0 };

  let inflated;
  try { inflated = zlib.inflateSync(Buffer.concat(idatBufs)); } catch { return { treeCount: 0, total: 0 }; }

  const pixels = decodePng(inflated, ihdr.width, ihdr.height, 4 /* RGBA */);
  let treeCount = 0, total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue; // transparent = noData/out-of-bounds
    total++;
    // Tree pixel: R≈0, G≈180, B≈0 (±15 tolerance for any server-side AA variation)
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    if (r <= 15 && g >= 165 && g <= 195 && b <= 15) treeCount++;
  }

  const result = { treeCount, total };
  _canopyCache.set(bboxStr, result);
  _canopyCacheAge.set(bboxStr, now);
  _saveToDisk(
    path.join(_DISK_CACHE_DIR, 'canopy', `${bboxStr.replace(/,/g, '_')}.json`),
    { bboxKey: bboxStr, treeCount: result.treeCount, total: result.total, age: now }
  );
  return result;
}

/** Compute canopy coverage percentages for a batch of {id, lng, lat} sites. */
async function _computeCanopyBatch(sites) {
  const settled = await Promise.allSettled(sites.map(s => _getCanopyPixels(s.lng, s.lat)));
  return sites.map((s, i) => {
    const r = settled[i];
    if (r.status !== 'fulfilled' || !r.value.total) {
      return { id: s.id, canopyPct: null, year: CANOPY_YEAR };
    }
    return {
      id:        s.id,
      canopyPct: Math.round(r.value.treeCount / r.value.total * 100),
      year:      CANOPY_YEAR,
    };
  });
}

async function proxyCanopyCheck(req, res) {
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
  if (sites.length > 50) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'batch too large (max 50 sites)' }));
    return;
  }
  try {
    const results = await _computeCanopyBatch(sites);
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

// ── iNaturalist historical observations proxy ─────────────────────────────────
// Fetches and caches all observations for a single calendar year near Green Bay.
// The client calls /api/inat-history/:year; the server returns the stripped
// observation array that client-side observationsToGeoJSON() can process.
//
// Only the fields required by the client (classifyObs + observationsToGeoJSON)
// are retained — reduces server memory from ~3 KB/obs to ~250 bytes/obs.
//
// Server-side TTL:
//   Years older than (currentYear − 1): 30 days  — data is final
//   Previous year:                        12 hours — may still receive late obs
//
// Background warmer at startup: fetches all years from INAT_HIST_START to
// currentYear−1, newest first, with 3 s between years.  Subsequent browser
// requests are served from server memory (instant).  After the warmer runs
// once, server restarts re-warm quickly from their own in-memory state.
//
// Browser Cache API (cache.js) stores the processed GeoJSON result for each
// year with a 7–30 day TTL, so most users only need to fetch from the server
// once per year before falling back entirely to client-side cache.

const INAT_HIST_START    = 2010;
const INAT_HIST_LAT      = 44.5133;
const INAT_HIST_LNG      = -88.0133;
const INAT_HIST_RADIUS   = 15;         // km, matches client config.js RADIUS_KM
const INAT_HIST_PLACE_ID = 59;         // Wisconsin preferred_place_id
const INAT_HIST_PER_PAGE = 200;
const INAT_HIST_MAX      = 2000;       // per-year cap; same as client MAX_OBS

const _inatHistCache    = new Map(); // year (number) → observations[]
const _inatHistCacheAge = new Map(); // year (number) → timestamp (ms)

/**
 * Strips an iNaturalist observation down to the fields that
 * observationsToGeoJSON() and classifyObs() actually need.
 * Reduces payload from ~3 KB/obs to ~200 bytes/obs.
 */
function _stripInatObs(obs) {
  const t = obs.taxon;
  return {
    id:          obs.id,
    location:    obs.location,
    observed_on: obs.observed_on,
    user:        obs.user ? { login: obs.user.login } : null,
    taxon: t ? {
      name:                  t.name,
      preferred_common_name: t.preferred_common_name,
      iconic_taxon_name:     t.iconic_taxon_name,
      endemic:               t.endemic,
      native:                t.native,
      introduced:            t.introduced,
      establishment_means:   t.establishment_means,
      default_photo:         t.default_photo ? { medium_url: t.default_photo.medium_url } : null,
    } : null,
  };
}

/**
 * Fetches (or serves from cache) all observations for the given calendar year
 * using iNaturalist cursor pagination.  Returns the stripped observation array.
 */
async function _fetchInatYear(year) {
  const now        = Date.now();
  const currentYear = new Date().getFullYear();
  const ttl        = year < currentYear - 1
    ? 30 * 24 * 60 * 60 * 1000   // 30 days for historical years
    : 12 * 60 * 60 * 1000;       // 12 hours for previous year

  const cached = _inatHistCache.get(year);
  if (cached && now - (_inatHistCacheAge.get(year) ?? 0) < ttl) return cached;

  const d1  = `${year}-01-01`;
  const d2  = `${year}-12-31`;
  const all = [];
  let idBelow = null;

  while (all.length < INAT_HIST_MAX) {
    const params = new URLSearchParams({
      lat:                INAT_HIST_LAT,
      lng:                INAT_HIST_LNG,
      radius:             INAT_HIST_RADIUS,
      per_page:           INAT_HIST_PER_PAGE,
      order:              'desc',
      order_by:           'id',
      preferred_place_id: INAT_HIST_PLACE_ID,
      d1, d2,
    });
    params.append('has[]', 'geo');
    if (idBelow) params.set('id_below', String(idBelow));

    const resp = await fetch(`https://api.inaturalist.org/v1/observations?${params}`, {
      headers: { 'User-Agent': 'habitat-map/1.0' },
    });
    if (!resp.ok) throw new Error(`iNat API ${resp.status} for year ${year}`);

    const data    = await resp.json();
    const results = data.results ?? [];
    if (results.length === 0) break;

    for (const obs of results) {
      if (obs.location) all.push(_stripInatObs(obs));
    }
    if (results.length < INAT_HIST_PER_PAGE) break;
    idBelow = Math.min(...results.map(r => r.id));
  }

  _inatHistCache.set(year, all);
  _inatHistCacheAge.set(year, Date.now());
  _saveToDisk(path.join(_DISK_CACHE_DIR, 'inat', `${year}.json`), { obs: all, age: _inatHistCacheAge.get(year) });
  return all;
}

/** Handle GET /api/inat-history/:year */
async function proxyInatHistory(yearStr, res) {
  const year = parseInt(yearStr, 10);
  const currentYear = new Date().getFullYear();
  if (!Number.isFinite(year) || year < 2008 || year >= currentYear) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'year out of range' }));
    return;
  }
  try {
    const obs = await _fetchInatYear(year);
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      // Tell browsers to cache for 1 hour; the server's own TTL is longer
      'Cache-Control':               'public, max-age=3600',
    });
    res.end(JSON.stringify(obs));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * Background warmer — fetches all years from INAT_HIST_START to currentYear−1,
 * newest first, pausing 3 s between years to stay within iNat rate limits.
 * Already-cached (and still-fresh) years are skipped instantly.
 */
async function _warmInatHistory() {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let y = currentYear - 1; y >= INAT_HIST_START; y--) years.push(y);
  const total = years.length;
  console.log(`[inat-warm] pre-fetching ${total} years of iNat history (${INAT_HIST_START}–${currentYear - 1})`);

  let warmed = 0, skipped = 0;
  for (const year of years) {
    const now     = Date.now();
    const ttl     = year < currentYear - 1 ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const cached  = _inatHistCache.get(year);
    if (cached && now - (_inatHistCacheAge.get(year) ?? 0) < ttl) { skipped++; continue; }

    await new Promise(r => setTimeout(r, 3000)); // 3 s between years

    try {
      const obs = await _fetchInatYear(year);
      warmed++;
      console.log(`[inat-warm] ${year}: ${obs.length} obs (${warmed + skipped}/${total})`);
    } catch (err) {
      console.warn(`[inat-warm] ${year} failed: ${err.message}`);
    }
  }
  console.log(`[inat-warm] complete — ${warmed} fetched, ${skipped} from cache`);
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
      where:             'PublicOwner IS NOT NULL',
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

          const body = JSON.stringify(geojson);
          const parcelAge = Date.now();
          _parcelTileCache.set(key, { body, age: parcelAge });
          _saveToDisk(path.join(_DISK_CACHE_DIR, 'parcels', `${key.replace(',', '_')}.json`), { body, age: parcelAge });
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

  const targetRgb = NLCD_COLORS[code];
  if (!targetRgb) {
    res.writeHead(400); res.end(`Unknown NLCD code: ${code}`); return;
  }

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
    _saveToDisk(path.join(_DISK_CACHE_DIR, 'cdl-fringe.json'), { body: cdlFringeCache, age: cdlFringeCacheTime });
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
    _saveToDisk(path.join(_DISK_CACHE_DIR, 'nass.json'), { body: nassCache, age: nassCacheTime });
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

// ── Historical snapshot system ────────────────────────────────────────────────
//
// Snapshots are pre-aggregated summaries stored as small JSON files under
// ./snapshots/.  Raw records are never written — only counters and top-N maps
// are held in memory during a harvest, then discarded once the file is written.
//
// POST /api/harvest  { source, year }  — triggers one harvest, writes file
// GET  /api/snapshots                  — returns index of available files
// GET  /api/snapshots/:filename        — serves one snapshot file

const SNAPSHOTS_DIR = path.join(ROOT, 'snapshots');

// Ensure the directory exists at startup without crashing if it already does.
try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch { /* already exists */ }

// ── Disk-backed cache persistence ─────────────────────────────────────────────
// All server-side in-memory caches are mirrored to snapshots/cache/ as flat JSON
// files so they survive server restarts. Writes are atomic (tmp → rename).

const _DISK_CACHE_DIR = path.join(SNAPSHOTS_DIR, 'cache');
for (const sub of ['inat', 'parcels', 'nlcd-nesting', 'canopy']) {
  try { fs.mkdirSync(path.join(_DISK_CACHE_DIR, sub), { recursive: true }); } catch { /* ok */ }
}

function _saveToDisk(filePath, data) {
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    console.warn('[cache] _saveToDisk failed:', filePath, e.message);
  }
}

function _loadFromDisk(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function _loadPersistedCaches() {
  let count = 0;

  // iNat history: snapshots/cache/inat/{year}.json
  let inatFiles = [];
  try { inatFiles = fs.readdirSync(path.join(_DISK_CACHE_DIR, 'inat')); } catch { /* empty */ }
  for (const f of inatFiles) {
    const m = f.match(/^(\d{4})\.json$/);
    if (!m) continue;
    const rec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'inat', f));
    if (rec && Array.isArray(rec.obs)) {
      _inatHistCache.set(parseInt(m[1], 10), rec.obs);
      _inatHistCacheAge.set(parseInt(m[1], 10), rec.age);
      count++;
    }
  }

  // Parcel tiles: snapshots/cache/parcels/{xi}_{yi}.json
  let parcelFiles = [];
  try { parcelFiles = fs.readdirSync(path.join(_DISK_CACHE_DIR, 'parcels')); } catch { /* empty */ }
  for (const f of parcelFiles) {
    if (!f.endsWith('.json')) continue;
    const rec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'parcels', f));
    if (rec && rec.body) {
      const key = f.slice(0, -5).replace('_', ',');
      _parcelTileCache.set(key, { body: rec.body, age: rec.age });
      count++;
    }
  }

  // NLCD nesting tiles: snapshots/cache/nlcd-nesting/{z}_{tx}_{ty}.json
  let nestFiles = [];
  try { nestFiles = fs.readdirSync(path.join(_DISK_CACHE_DIR, 'nlcd-nesting')); } catch { /* empty */ }
  for (const f of nestFiles) {
    if (!f.endsWith('.json')) continue;
    const rec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'nlcd-nesting', f));
    if (rec && rec.indices && rec.palMap) {
      const key     = f.slice(0, -5).replace(/_/g, '/');
      const palMap  = new Map(rec.palMap);
      const indices = Uint8Array.from(Buffer.from(rec.indices, 'base64'));
      _nestingTileCache.set(key, { palMap, indices, width: rec.width, height: rec.height });
      _nestingTileCacheAge.set(key, rec.age);
      count++;
    }
  }

  // Canopy tiles: snapshots/cache/canopy/{bboxKey}.json
  let canopyFiles = [];
  try { canopyFiles = fs.readdirSync(path.join(_DISK_CACHE_DIR, 'canopy')); } catch { /* empty */ }
  for (const f of canopyFiles) {
    if (!f.endsWith('.json')) continue;
    const rec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'canopy', f));
    if (rec && rec.bboxKey) {
      _canopyCache.set(rec.bboxKey, { treeCount: rec.treeCount, total: rec.total });
      _canopyCacheAge.set(rec.bboxKey, rec.age);
      count++;
    }
  }

  // CDL fringe: snapshots/cache/cdl-fringe.json
  const cdlRec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'cdl-fringe.json'));
  if (cdlRec && cdlRec.body) {
    cdlFringeCache     = cdlRec.body;
    cdlFringeCacheTime = cdlRec.age;
    count++;
  }

  // NASS: snapshots/cache/nass.json
  const nassRec = _loadFromDisk(path.join(_DISK_CACHE_DIR, 'nass.json'));
  if (nassRec && nassRec.body) {
    nassCache     = nassRec.body;
    nassCacheTime = nassRec.age;
    count++;
  }

  if (count > 0) console.log(`[cache] Restored ${count} persisted cache entries.`);
}

// ── iNat classification helpers (mirrors js/classify.js without ES modules) ──
const INSECT_POLLINATOR_RE = /\bbee(s)?\b|bumblebee|bumble\s+bee|honey\s+bee|mason\s+bee|sweat\s+bee|leafcutter|miner\s+bee|butterfly|butterflies|\bskipper(s)?\b|\bmoth(s)?\b|hoverfly|hover[\s-]fl(y|ies)|flower\s+fl(y|ies)/i;

function _classifyInat(obs) {
  const taxon  = obs.taxon;
  if (!taxon) return 'other-wildlife';
  const iconic = taxon.iconic_taxon_name;
  const cn     = taxon.preferred_common_name ?? '';

  // Pollinator check (mirrors isPollinator in classify.js)
  if (iconic === 'Aves' && /hummingbird/i.test(cn))  return 'pollinators';
  if (iconic === 'Insecta' && INSECT_POLLINATOR_RE.test(cn)) return 'pollinators';

  // Plant native/non-native (mirrors classifyObs)
  if (iconic === 'Plantae') {
    const em  = taxon.establishment_means;
    const raw = em ? (typeof em === 'string' ? em : (em.establishment_means ?? '')).toLowerCase().trim() : '';
    const key = raw === 'naturalized' ? 'naturalised' : raw;
    return (key === 'native' || key === 'endemic') ? 'native-plants' : 'other-plants';
  }

  return 'other-wildlife';
}

// ── GBIF classification helper ────────────────────────────────────────────────
function _classifyGbif(occ) {
  const kingdom = (occ.kingdom ?? '').toLowerCase();
  const cn      = (occ.vernacularName ?? occ.species ?? '').toLowerCase();
  if (INSECT_POLLINATOR_RE.test(cn)) return 'pollinators';
  if (kingdom === 'plantae') {
    const status = (occ.establishmentMeans ?? '').toLowerCase();
    return (status === 'native' || status === 'endemic') ? 'native-plants' : 'other-plants';
  }
  return 'other-wildlife';
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function _monthKey(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).slice(5, 7);
  return /^\d{2}$/.test(m) ? m : null;
}

function _topN(freq, n) {
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function _jsonRes(res, status, obj) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

// ── Harvest: iNat ─────────────────────────────────────────────────────────────
// Month keys for byLayerByMonth initialisation
const _MONTHS = ['01','02','03','04','05','06','07','08','09','10','11','12'];
function _emptyMonthMap() {
  return Object.fromEntries(_MONTHS.map(m => [m, 0]));
}

async function _harvestInat(year) {
  const CENTER_LAT = 44.5133, CENTER_LNG = -88.0133, RADIUS_KM = 15;
  const PER_PAGE = 200, MAX_OBS = 5000;

  const byLayer = { pollinators: 0, 'native-plants': 0, 'other-plants': 0, 'other-wildlife': 0 };
  // Per-layer monthly breakdown — only pollinators + native-plants tracked
  const byLayerByMonth = {
    pollinators:    _emptyMonthMap(),
    'native-plants': _emptyMonthMap(),
  };
  const byMonth = {};
  const speciesFreq = {};
  // Per-layer species maps (pollinators + native-plants only)
  const speciesByLayer = { pollinators: {}, 'native-plants': {} };
  let total = 0, fetched = 0, idBelow = null;

  while (fetched < MAX_OBS) {
    const params = new URLSearchParams({
      lat: CENTER_LAT, lng: CENTER_LNG, radius: RADIUS_KM,
      per_page: PER_PAGE, order: 'desc', order_by: 'id',
      preferred_place_id: 59,
      d1: `${year}-01-01`, d2: `${year}-12-31`,
    });
    params.append('has[]', 'geo');
    if (idBelow) params.set('id_below', String(idBelow));

    const resHttp = await httpsGetBuf('api.inaturalist.org', `/v1/observations?${params}`);
    const data = JSON.parse(resHttp.toString());
    total = data.total_results ?? total;
    const results = data.results ?? [];
    if (!results.length) break;

    for (const obs of results) {
      const layer = _classifyInat(obs);
      byLayer[layer]++;
      const mk = _monthKey(obs.observed_on ?? obs.time_observed_at);
      if (mk) byMonth[mk] = (byMonth[mk] || 0) + 1;
      const sp = obs.taxon?.preferred_common_name || obs.taxon?.name;
      if (sp) speciesFreq[sp] = (speciesFreq[sp] || 0) + 1;
      // Track per-layer monthly + species only for relevant layers
      if (layer === 'pollinators' || layer === 'native-plants') {
        if (mk) byLayerByMonth[layer][mk]++;
        if (sp) speciesByLayer[layer][sp] = (speciesByLayer[layer][sp] || 0) + 1;
      }
      idBelow = idBelow ? Math.min(idBelow, obs.id) : obs.id;
    }
    fetched += results.length;
    if (results.length < PER_PAGE) break;
  }

  return {
    schemaVersion: 2,
    source: 'inat', year, harvestedAt: new Date().toISOString(),
    total: fetched, byLayer,
    byLayerByMonth,
    speciesRichness: Object.keys(speciesFreq).length,
    topSpecies: _topN(speciesFreq, 10),
    topPollinators:  _topN(speciesByLayer.pollinators, 10),
    topNativePlants: _topN(speciesByLayer['native-plants'], 10),
    byMonth,
  };
}

// ── Harvest: GBIF ─────────────────────────────────────────────────────────────
async function _harvestGbif(year) {
  const CENTER_LAT = 44.5133, CENTER_LNG = -88.0133, RADIUS_KM = 15;
  const latDelta = RADIUS_KM / 111.0;
  const lngDelta = RADIUS_KM / (111.0 * Math.cos(CENTER_LAT * Math.PI / 180));
  const minLat = (CENTER_LAT - latDelta).toFixed(4);
  const maxLat = (CENTER_LAT + latDelta).toFixed(4);
  const minLng = (CENTER_LNG - lngDelta).toFixed(4);
  const maxLng = (CENTER_LNG + lngDelta).toFixed(4);

  const PER_PAGE = 300, MAX_OBS = 1200;
  const byLayer = { pollinators: 0, 'native-plants': 0, 'other-plants': 0, 'other-wildlife': 0 };
  const byLayerByMonth = {
    pollinators:    _emptyMonthMap(),
    'native-plants': _emptyMonthMap(),
  };
  const byMonth = {};
  const speciesFreq = {};
  const speciesByLayer = { pollinators: {}, 'native-plants': {} };
  let fetched = 0, offset = 0;

  while (fetched < MAX_OBS) {
    const encoded = new URLSearchParams({
      hasCoordinate: 'true', hasGeospatialIssue: 'false',
      limit: String(PER_PAGE), offset: String(offset),
    }).toString();
    const gbifUrl = `https://api.gbif.org/v1/occurrence/search?${encoded}`
      + `&decimalLatitude=${minLat},${maxLat}`
      + `&decimalLongitude=${minLng},${maxLng}`
      + `&eventDate=${year}-01-01,${year}-12-31`;

    const parsedU = new URL(gbifUrl);
    const buf = await httpsGetBuf(parsedU.hostname, parsedU.pathname + parsedU.search);
    const data = JSON.parse(buf.toString());
    const batch = data.results ?? [];
    if (!batch.length) break;

    for (const occ of batch) {
      const layer = _classifyGbif(occ);
      byLayer[layer]++;
      const mk = _monthKey(occ.eventDate);
      if (mk) byMonth[mk] = (byMonth[mk] || 0) + 1;
      const sp = occ.vernacularName || occ.species;
      if (sp) speciesFreq[sp] = (speciesFreq[sp] || 0) + 1;
      if (layer === 'pollinators' || layer === 'native-plants') {
        if (mk) byLayerByMonth[layer][mk]++;
        if (sp) speciesByLayer[layer][sp] = (speciesByLayer[layer][sp] || 0) + 1;
      }
    }
    fetched += batch.length;
    if (data.endOfRecords || fetched >= MAX_OBS) break;
    offset += PER_PAGE;
  }

  return {
    schemaVersion: 2,
    source: 'gbif', year, harvestedAt: new Date().toISOString(),
    total: fetched, byLayer,
    byLayerByMonth,
    speciesRichness: Object.keys(speciesFreq).length,
    topSpecies: _topN(speciesFreq, 10),
    topPollinators:  _topN(speciesByLayer.pollinators, 10),
    topNativePlants: _topN(speciesByLayer['native-plants'], 10),
    byMonth,
  };
}

// ── Harvest: NOAA GHCND ───────────────────────────────────────────────────────
async function _harvestNoaa(year) {
  const token = getNoaaToken();
  if (!token) return { available: false, reason: 'No NOAA_CDO_TOKEN configured' };

  const nceiPath =
    `/access/services/data/v1?dataset=daily-summaries` +
    `&stations=${NOAA_STATION_ID}` +
    `&startDate=${year}-01-01&endDate=${year}-12-31` +
    `&dataTypes=TMAX,TMIN&format=json&units=standard`;

  let buf;
  try {
    buf = await new Promise((resolve, reject) => {
      https.get(
        { hostname: 'www.ncei.noaa.gov', path: nceiPath, timeout: 30000,
          headers: { token, 'User-Agent': 'habitat-map/1.0' } },
        r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
        }
      ).on('error', reject);
    });
  } catch (e) {
    return { available: false, reason: e.message };
  }

  const records = JSON.parse(buf.toString());
  if (!Array.isArray(records)) return { available: false, reason: 'Unexpected NOAA response' };

  // Group by month; accumulate GDD base-50°F (TMAX+TMIN)/2 - 50, floor 0
  const months = {};
  let gddTotal = 0;
  for (const r of records) {
    const mk = _monthKey(r.DATE);
    if (!mk) continue;
    if (!months[mk]) months[mk] = { tmaxSum: 0, tminSum: 0, days: 0, gdd: 0 };
    const tmax = r.TMAX != null ? r.TMAX : null;
    const tmin = r.TMIN != null ? r.TMIN : null;
    if (tmax !== null && tmin !== null) {
      const avg = (tmax + tmin) / 2;
      const gdd = Math.max(0, avg - 50);
      months[mk].tmaxSum += tmax;
      months[mk].tminSum += tmin;
      months[mk].gdd     += gdd;
      months[mk].days++;
      gddTotal += gdd;
    }
  }

  const byMonth = {};
  for (const [mk, m] of Object.entries(months)) {
    byMonth[mk] = {
      avgTmax: m.days ? +(m.tmaxSum / m.days).toFixed(1) : null,
      avgTmin: m.days ? +(m.tminSum / m.days).toFixed(1) : null,
      gdd:     +m.gdd.toFixed(1),
    };
  }

  return { source: 'noaa', year, harvestedAt: new Date().toISOString(), gddTotal: +gddTotal.toFixed(1), byMonth };
}

// ── Harvest: NASS QuickStats ──────────────────────────────────────────────────
async function _harvestNass(year) {
  if (!getNassApiKey()) return { available: false, reason: 'No NASS_API_KEY configured' };

  const results = await new Promise((resolve) => {
    let pending = 2, coloniesData = null, cropsData = null;
    const done = () => { if (--pending === 0) resolve({ coloniesData, cropsData }); };
    nassGet({ source_desc: 'SURVEY', commodity_desc: 'HONEY', statisticcat_desc: 'COLONIES',
              agg_level_desc: 'STATE', state_fips_code: '55', year: String(year) },
      (_, d) => { coloniesData = d; done(); });
    nassGet({ source_desc: 'CENSUS', year: String(year), state_fips_code: '55', county_code: '009',
              statisticcat_desc: 'AREA HARVESTED', agg_level_desc: 'COUNTY' },
      (_, d) => { cropsData = d; done(); });
  });

  // Reuse the existing combine helper
  const combined = combineNassData(results.coloniesData, results.cropsData);
  return { source: 'nass', year, harvestedAt: new Date().toISOString(), ...combined };
}

// ── Harvest: CDL stats ────────────────────────────────────────────────────────
async function _harvestCdl(year) {
  const cdlUrl = `https://nassgeodata.gmu.edu/axis2/services/CDLService/GetCDLStat?year=${year}&fips=55009&format=json`;
  let xml;
  try { xml = (await httpsGetBuf('nassgeodata.gmu.edu',
    `/axis2/services/CDLService/GetCDLStat?year=${year}&fips=55009&format=json`)).toString(); }
  catch (e) { return { available: false, reason: e.message }; }

  const match = xml.match(/<returnURL>([^<]+)<\/returnURL>/);
  if (!match) return { available: false, reason: 'CDL service returned no data URL' };

  let raw;
  try {
    const u = new URL(match[1]);
    raw = (await httpsGetBuf(u.hostname, u.pathname + u.search)).toString();
  } catch (e) { return { available: false, reason: e.message }; }

  const fixed = raw.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
  let parsed;
  try { parsed = JSON.parse(fixed); } catch { return { available: false, reason: 'CDL JSON parse failed' }; }

  const rows = (parsed.rows ?? []).map(r => ({ category: r.Category ?? r.category ?? '', acreage: +(r.Acreage ?? r.acreage ?? 0) }));
  return { source: 'cdl', year, harvestedAt: new Date().toISOString(), rows };
}

// ── Server-side auto-harvesting ───────────────────────────────────────────────
//
// Runs at startup (after a 20-second delay) and fills in any missing or stale
// snapshot files without requiring manual intervention.
//
// Rate-limit safety:
//   iNat / GBIF : 1.5 s between paginated pages; 8 s between years
//   NOAA CDO    : 8 s between years  (hard limit 1,000 req/day)
//   NASS / CDL  : 5 s between years  (no documented limit; polite minimum)
//
// Keyed sources (NOAA, NASS) are skipped gracefully when the API key is absent.
// All harvesting is sequential — never parallel — to honour rate limits.

const AUTO_HARVEST_START_YEAR  = 2015;
const AUTO_HARVEST_DELAYS_MS   = { inat: 8000, gbif: 8000, noaa: 8000, nass: 5000, cdl: 5000 };
const AUTO_HARVEST_STALE_DAYS  = { historical: 30, current: 1 }; // days before re-harvest

let _autoHarvestStatus = { running: false, queue: [], lastCompleted: null, lastError: null };

async function _autoHarvestMissing() {
  if (_autoHarvestStatus.running) return;
  _autoHarvestStatus.running = true;
  _autoHarvestStatus.queue   = [];

  const currentYear = new Date().getFullYear();
  const now         = Date.now();

  // Read existing snapshot files
  let existing;
  try { existing = new Set(fs.readdirSync(SNAPSHOTS_DIR).filter(f => /^[a-z]+-\d{4}\.json$/.test(f))); }
  catch { existing = new Set(); }

  /** Returns true when a snapshot should be (re-)harvested */
  function _needsHarvest(source, year) {
    const file = `${source}-${year}.json`;
    if (!existing.has(file)) return true;
    try {
      const stat = fs.statSync(path.join(SNAPSHOTS_DIR, file));
      const ageDays = (now - stat.mtimeMs) / 86400000;
      const threshold = year < currentYear ? AUTO_HARVEST_STALE_DAYS.historical : AUTO_HARVEST_STALE_DAYS.current;
      return ageDays > threshold;
    } catch { return true; }
  }

  // Build queue: all sources × all years, newest first, keyed sources gated on key presence
  const sources = ['inat', 'gbif'];
  if (getNoaaToken())   sources.push('noaa');
  if (getNassApiKey())  sources.push('nass');
  sources.push('cdl');

  const queue = [];
  for (const source of sources) {
    for (let year = currentYear; year >= AUTO_HARVEST_START_YEAR; year--) {
      if (_needsHarvest(source, year)) queue.push({ source, year });
    }
  }
  _autoHarvestStatus.queue = queue.map(q => `${q.source}-${q.year}`);

  console.log(`[auto-harvest] ${queue.length} snapshot(s) to refresh`);

  for (const { source, year } of queue) {
    const label = `${source}-${year}`;
    try {
      let snapshot;
      switch (source) {
        case 'inat': snapshot = await _harvestInat(year); break;
        case 'gbif': snapshot = await _harvestGbif(year); break;
        case 'noaa': snapshot = await _harvestNoaa(year); break;
        case 'nass': snapshot = await _harvestNass(year); break;
        case 'cdl':  snapshot = await _harvestCdl(year);  break;
      }
      if (snapshot?.available === false) {
        console.log(`[auto-harvest] ${label} → skipped (${snapshot.reason})`);
      } else {
        const dest = path.join(SNAPSHOTS_DIR, `${label}.json`);
        fs.writeFileSync(dest, JSON.stringify(snapshot, null, 2));
        existing.add(`${label}.json`);
        const pollinators   = snapshot.byLayer?.pollinators   ?? '?';
        const nativePlants  = snapshot.byLayer?.['native-plants'] ?? '?';
        console.log(`[auto-harvest] ${label} → done (${pollinators} pollinators, ${nativePlants} native-plants)`);
      }
      _autoHarvestStatus.lastCompleted = label;
      _autoHarvestStatus.queue = _autoHarvestStatus.queue.filter(q => q !== label);
    } catch (err) {
      console.warn(`[auto-harvest] ${label} → error: ${err.message}`);
      _autoHarvestStatus.lastError = `${label}: ${err.message}`;
    }
    // Rate-limit pause between harvests
    await new Promise(r => setTimeout(r, AUTO_HARVEST_DELAYS_MS[source] ?? 5000));
  }

  _autoHarvestStatus.running = false;
  console.log('[auto-harvest] run complete');
}

// ── Server-side Commons photo snapshot ───────────────────────────────────────
//
// Fetches Wikimedia Commons geotagged photos near Green Bay server-side and
// caches the result in snapshots/cache/commons-photos.json.  This allows the
// client to retrieve pre-filtered images from one local endpoint instead of
// making 5 parallel CORS requests to Wikimedia on each page load.
//
// Refreshed at startup (after 30 s) and then weekly.

const COMMONS_SNAPSHOT_PATH = path.join(_DISK_CACHE_DIR, 'commons-photos.json');
const COMMONS_SNAPSHOT_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days
const COMMONS_CENTER_LAT    = 44.5133;
const COMMONS_CENTER_LNG    = -88.0133;
const COMMONS_GEO_API       = 'commons.wikimedia.org';

async function _fetchCommonsPage(lat, lng, radiusM, gcontinue) {
  const params = new URLSearchParams({
    action:       'query',
    generator:    'geosearch',
    ggscoord:     `${lat}|${lng}`,
    ggsradius:    String(Math.min(radiusM, 10000)),
    ggsnamespace: '6',
    ggslimit:     '500',
    prop:         'imageinfo|coordinates',
    iiprop:       'url|extmetadata',
    iiurlwidth:   '400',
    format:       'json',
    origin:       '*',
  });
  if (gcontinue) { for (const [k, v] of Object.entries(gcontinue)) params.set(k, v); }
  const buf = await httpsGetBuf(COMMONS_GEO_API, `/w/api.php?${params}`);
  return JSON.parse(buf.toString());
}

/** Server-side relevance filter — mirrors the client isRelevant logic. */
function _commonsIsRelevant(page) {
  const ii  = page.imageinfo?.[0];
  if (!ii?.extmetadata?.LicenseShortName?.value) return false;
  if (!ii.thumburl) return false;
  return true;
}

/** Haversine distance in km. */
function _commonsHaversine(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function _refreshCommonsSnapshot() {
  console.log('[commons-snapshot] refreshing…');
  const RADIUS_KM = 15;
  const offsetKm  = 8;
  const dLat = offsetKm / 111.32;
  const dLng = offsetKm / (111.32 * Math.cos(COMMONS_CENTER_LAT * Math.PI / 180));
  const queryPoints = [
    [COMMONS_CENTER_LAT,          COMMONS_CENTER_LNG         ],
    [COMMONS_CENTER_LAT + dLat,   COMMONS_CENTER_LNG         ],
    [COMMONS_CENTER_LAT - dLat,   COMMONS_CENTER_LNG         ],
    [COMMONS_CENTER_LAT,          COMMONS_CENTER_LNG + dLng  ],
    [COMMONS_CENTER_LAT,          COMMONS_CENTER_LNG - dLng  ],
  ];

  const seen = new Set();
  const results = [];

  for (const [qLat, qLng] of queryPoints) {
    let gcontinue = null, pages = 0;
    while (pages < 3) {
      try {
        const data  = await _fetchCommonsPage(qLat, qLng, 10000, gcontinue);
        const batch = Object.values(data?.query?.pages ?? {});
        for (const page of batch) {
          if (seen.has(page.pageid)) continue;
          seen.add(page.pageid);
          if (!_commonsIsRelevant(page)) continue;
          const coord = page.coordinates?.[0];
          if (!coord?.lat || !coord?.lon) continue;
          if (_commonsHaversine(COMMONS_CENTER_LAT, COMMONS_CENTER_LNG, +coord.lat, +coord.lon) > RADIUS_KM) continue;
          const ii  = page.imageinfo?.[0] ?? {};
          const ext = ii.extmetadata ?? {};
          const strip = s => String(s ?? '').replace(/<[^>]*>/g, '').trim();
          results.push({
            pageId:      page.pageid,
            title:       (page.title ?? '').replace(/^File:/, ''),
            thumburl:    ii.thumburl    ?? '',
            thumbwidth:  ii.thumbwidth  ?? 400,
            thumbheight: ii.thumbheight ?? 300,
            descurl:     ii.descriptionurl ?? '',
            description: strip(ext.ImageDescription?.value) || (page.title ?? '').replace(/^File:/, ''),
            artist:      strip(ext.Artist?.value) || 'Unknown',
            license:     strip(ext.LicenseShortName?.value) || '',
            lat:         +coord.lat,
            lng:         +coord.lon,
          });
        }
        pages++;
        if (!data.continue) break;
        gcontinue = data.continue;
      } catch (err) {
        console.warn(`[commons-snapshot] query error: ${err.message}`);
        break;
      }
      await new Promise(r => setTimeout(r, 500)); // polite pause between pages
    }
    await new Promise(r => setTimeout(r, 1000)); // polite pause between query points
  }

  try {
    fs.mkdirSync(_DISK_CACHE_DIR, { recursive: true });
    _saveToDisk(COMMONS_SNAPSHOT_PATH, { refreshedAt: new Date().toISOString(), images: results });
    console.log(`[commons-snapshot] saved ${results.length} images`);
  } catch (err) {
    console.warn(`[commons-snapshot] save error: ${err.message}`);
  }
}

function _scheduleCommonsSnapshot() {
  const exists = fs.existsSync(COMMONS_SNAPSHOT_PATH);
  let stale = true;
  if (exists) {
    try {
      const age = Date.now() - fs.statSync(COMMONS_SNAPSHOT_PATH).mtimeMs;
      stale = age > COMMONS_SNAPSHOT_TTL;
    } catch { /* stale = true */ }
  }
  if (stale) {
    setTimeout(_refreshCommonsSnapshot, 30000);
  } else {
    console.log('[commons-snapshot] cache fresh, skipping initial refresh');
  }
  // Re-check weekly regardless
  setInterval(_refreshCommonsSnapshot, COMMONS_SNAPSHOT_TTL);
}

function handleCommonsSnapshot(res) {
  try {
    if (fs.existsSync(COMMONS_SNAPSHOT_PATH)) {
      const raw    = JSON.parse(fs.readFileSync(COMMONS_SNAPSHOT_PATH, 'utf8'));
      const images = raw.images ?? [];
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=3600',
      });
      res.end(JSON.stringify(images));
    } else {
      res.writeHead(200, {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'no-cache',
      });
      res.end(JSON.stringify([]));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

function handleHarvestStatus(res) {
  _jsonRes(res, 200, {
    running:       _autoHarvestStatus.running,
    queue:         _autoHarvestStatus.queue,
    lastCompleted: _autoHarvestStatus.lastCompleted,
    lastError:     _autoHarvestStatus.lastError,
  });
}

// ── POST /api/harvest ─────────────────────────────────────────────────────────
function handleHarvest(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1024) { body = ''; req.destroy(); } });
  req.on('end', async () => {
    let source, year;
    try {
      const parsed = JSON.parse(body);
      source = parsed.source;
      year   = parseInt(parsed.year, 10);
      if (!['inat','gbif','noaa','nass','cdl'].includes(source)) throw new Error('invalid source');
      if (!year || year < 2000 || year > new Date().getFullYear()) throw new Error('invalid year');
    } catch (e) {
      _jsonRes(res, 400, { ok: false, error: e.message });
      return;
    }

    const file = `${source}-${year}.json`;
    const dest = path.join(SNAPSHOTS_DIR, file);

    let snapshot;
    try {
      switch (source) {
        case 'inat': snapshot = await _harvestInat(year); break;
        case 'gbif': snapshot = await _harvestGbif(year); break;
        case 'noaa': snapshot = await _harvestNoaa(year); break;
        case 'nass': snapshot = await _harvestNass(year); break;
        case 'cdl':  snapshot = await _harvestCdl(year);  break;
      }
      fs.writeFileSync(dest, JSON.stringify(snapshot, null, 2));
      const records = snapshot.total ?? snapshot.rows?.length ?? 0;
      _jsonRes(res, 200, { ok: true, file, records });
    } catch (err) {
      _jsonRes(res, 502, { ok: false, error: err.message });
    }
  });
}

// ── GET /api/snapshots (index + individual files) ─────────────────────────────
function handleSnapshotsIndex(res) {
  let entries;
  try { entries = fs.readdirSync(SNAPSHOTS_DIR); } catch { entries = []; }
  const files = entries.filter(f => /^[a-z]+-\d{4}\.json$/.test(f)).sort();
  _jsonRes(res, 200, { files });
}

function handleSnapshotFile(filename, res) {
  // Strict whitelist: only lowercase letters, hyphen, 4-digit year, .json
  if (!/^[a-z]+-\d{4}\.json$/.test(filename)) {
    _jsonRes(res, 400, { error: 'Invalid snapshot filename' });
    return;
  }
  const filePath = path.join(SNAPSHOTS_DIR, filename);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      _jsonRes(res, err.code === 'ENOENT' ? 404 : 500, { error: err.message });
      return;
    }
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=86400',
    });
    res.end(data);
  });
}

// ── System health endpoint ─────────────────────────────────────────────────────
// GET /api/health — returns the configured/missing status of all optional API
// keys so the client can surface actionable missing-key warnings on startup.

function handleHealth(res) {
  const payload = {
    keys: {
      NASS_API_KEY: {
        present:     !!getNassApiKey(),
        system:      'USDA NASS QuickStats',
        description: 'Managed colony counts and crop-acreage data',
        url:         'https://quickstats.nass.usda.gov/api',
      },
      EBIRD_API_KEY: {
        present:     !!getEbirdApiKey(),
        system:      'Cornell eBird API',
        description: 'Bird sighting observations',
        url:         'https://ebird.org/api/keygen',
      },
      NOAA_CDO_TOKEN: {
        present:     !!getNoaaToken(),
        system:      'NOAA CDO / NCEI Climate Data',
        description: 'Live GDD accumulation and current-year temperature data',
        url:         'https://www.ncdc.noaa.gov/cdo-web/token',
      },
    },
  };
  res.writeHead(200, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control':               'no-cache',
  });
  res.end(JSON.stringify(payload));
}

// ──────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // System health — API key status
  if (pathname === '/api/health') {
    handleHealth(res);
    return;
  }

  // Historical snapshot harvest (POST only)
  if (pathname === '/api/harvest') {
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    handleHarvest(req, res);
    return;
  }

  // Auto-harvest status (for debugging)
  if (pathname === '/api/harvest-status') {
    handleHarvestStatus(res);
    return;
  }

  // Server-side Commons photo snapshot (pre-filtered, cached weekly)
  if (pathname === '/api/commons-snapshot') {
    handleCommonsSnapshot(res);
    return;
  }

  // Bundled climate normals (NOAA API disrupted 2025)
  if (pathname === '/api/climate-normals') {
    const normalsPath = path.join(ROOT, 'snapshots', 'climate-normals-USW00014898.json');
    fs.readFile(normalsPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2592000', // 30 days
      });
      res.end(data);
    });
    return;
  }

  // Observed temperature archive (IEM-sourced, per-year)
  const obsMatch = pathname.match(/^\/api\/observed-temps\/(\d{4})$/);
  if (obsMatch) {
    const yr = parseInt(obsMatch[1], 10);
    if (yr < 2021 || yr > 2030) { res.writeHead(404); res.end('Not found'); return; }
    const obsPath = path.join(ROOT, 'snapshots', `observed-temps-GRB-${yr}.json`);
    fs.readFile(obsPath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400', // 1 day (2025 grows during the year)
      });
      res.end(data);
    });
    return;
  }

  // Snapshot index + individual file serving
  if (pathname === '/api/snapshots') {
    handleSnapshotsIndex(res);
    return;
  }
  const snapshotMatch = pathname.match(/^\/api\/snapshots\/(.+)$/);
  if (snapshotMatch) {
    handleSnapshotFile(snapshotMatch[1], res);
    return;
  }

  // Proxy: HNP guest API (no CORS headers on their server)
  if (pathname === '/api/hnp-plantings') {
    proxyHnp(res);
    return;
  }

  // Lightweight count-only endpoint for marketing page (avoids shipping full US dataset)
  if (pathname === '/api/hnp-count') {
    proxyHnpCount(res);
    return;
  }

  // Ping: USDA CropScape CDL WMS reachability check (server-side HEAD, no CORS)
  if (pathname === '/api/cdl-ping') {
    proxyCdlPing(res);
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

  // Batch: WI DNR Urban Tree Canopy coverage % for a set of corridor sites
  if (pathname === '/api/canopy-check') {
    proxyCanopyCheck(req, res);
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

  // iNaturalist historical observations (proxied + pre-cached server-side)
  const inatHistMatch = pathname.match(/^\/api\/inat-history\/(\d{4})$/);
  if (inatHistMatch) {
    proxyInatHistory(inatHistMatch[1], res);
    return;
  }

  // Proxy: NLCD per-class filtered tile
  const nlcdMatch = pathname.match(/^\/api\/nlcd-tile\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/);
  if (nlcdMatch) {
    const [, codeStr, zStr, xStr, yStr] = nlcdMatch;
    proxyNlcdTile(Number(codeStr), Number(zStr), Number(xStr), Number(yStr), res);
    return;
  }

  // Normalise paths: marketing pages served at root-level URLs; /app → the tool.
  const WEB_ROUTES = new Map([
    ['/',                    '/website/bayhive-site.html'],
    ['/app',                 '/index.html'],
    ['/guide.html',          '/website/guide.html'],
    ['/reference.html',      '/website/reference.html'],
    ['/open-source.html',    '/website/open-source.html'],
    ['/bayhive-styles.css',  '/website/bayhive-styles.css'],
    ['/nav.js',              '/website/nav.js'],
  ]);
  // Rewrite /img/* → /website/img/* so website images are served correctly
  const rewritten = pathname.startsWith('/img/') ? '/website' + pathname : pathname;
  const relative = WEB_ROUTES.get(rewritten) ?? rewritten;

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
    const ext     = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream' };
    // JS and CSS files are never browser-cached in dev so code changes take effect immediately
    if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Serving ${ROOT}`);
  console.log(`Open → http://localhost:${PORT}`);
  // Restore all in-memory caches from disk before warming.
  _loadPersistedCaches();
  // Pre-warm the parcel tile cache in the background.
  // 300 tiles × 2.5 s ≈ 12.5 min; already-cached tiles are skipped instantly.
  setTimeout(_warmParcelCache, 5000);
  // Pre-warm iNaturalist historical observation cache.
  // Years fetch newest-first; each year takes a few seconds + 3 s pause.
  // Already-cached years are skipped; TTL: 30 days (old years), 12 h (prev year).
  setTimeout(_warmInatHistory, 10000);
  // Auto-harvest missing/stale snapshot files for the trends panel.
  // Runs after the iNat history warmer starts, sequentially with rate-limit pauses.
  setTimeout(_autoHarvestMissing, 20000);
  // Refresh the server-side Wikimedia Commons photo snapshot (weekly).
  _scheduleCommonsSnapshot();
});
