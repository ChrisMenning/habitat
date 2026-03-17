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

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // Proxy: HNP guest API (no CORS headers on their server)
  if (pathname === '/api/hnp-plantings') {
    proxyHnp(res);
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
