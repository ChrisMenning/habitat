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
