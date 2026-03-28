/**
 * cache.js — Browser Cache API wrapper with TTL.
 *
 * Uses the browser's built-in Cache API (available in the main thread without a
 * service worker) to persist processed GeoJSON between page loads.
 *
 * Two TTL tiers are used by app.js callers:
 *   • Observation data (iNat / GBIF)         — 1 h,  keyed by date range
 *   • Static area data (PAD-US, DNR, GBCC…)  — 24 h, fixed keys
 *
 * Observation keys embed the date range so a change in dates is a natural
 * cache miss — no manual invalidation needed.
 *
 * TTL metadata is stored as custom response headers alongside each entry so no
 * separate bookkeeping store is required. The Cache API has no practical size
 * limit (governed by browser storage quota, typically hundreds of MB).
 *
 * If the Cache API is unavailable (non-secure context, private-browsing
 * restriction, or storage quota exceeded) every function degrades gracefully:
 * cacheGet returns null (cache miss), cacheSet is a silent no-op.
 */

const CACHE_NAME = 'bayhive-v2';
const KEY_BASE   = '/cache/';

/**
 * Retrieves a cached value. Returns null on miss or if the entry is expired.
 *
 * @param {string} key
 * @returns {Promise<unknown|null>}
 */
export async function cacheGet(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp  = await cache.match(KEY_BASE + key);
    if (!resp) return null;

    const ts  = Number(resp.headers.get('x-bh-ts')  ?? 0);
    const ttl = Number(resp.headers.get('x-bh-ttl') ?? 0);
    if (Date.now() - ts > ttl) {
      void cache.delete(KEY_BASE + key);
      return null;
    }

    return await resp.json();
  } catch {
    return null;  // Cache API unavailable — degrade gracefully
  }
}

/**
 * Stores a value in the cache with the given TTL.
 * Silently swallows errors so cache failures never break the app.
 *
 * @param {string}  key
 * @param {unknown} data    — must be JSON-serialisable
 * @param {number}  ttlMs
 * @returns {Promise<void>}
 */
export async function cacheSet(key, data, ttlMs) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      KEY_BASE + key,
      new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'x-bh-ts':      String(Date.now()),
          'x-bh-ttl':     String(ttlMs),
        },
      }),
    );
  } catch (e) {
    console.warn('[cache] write failed:', e.message);
  }
}
