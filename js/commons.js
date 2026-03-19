/**
 * commons.js — Wikimedia Commons geotagged photography integration.
 *
 * Two-step approach (generator=geosearch is unreliable for files on Commons):
 *   Step 1 — list=geosearch → returns file page IDs near a coordinate.
 *   Step 2 — prop=imageinfo|categories|coordinates on those page IDs
 *             → fetches image URLs, license, and category membership.
 *
 * Topic filter: keep only images whose title or category membership matches
 * pollinator / native-plant keywords (CAT_KEYWORDS).  Images without a
 * license or thumbnail are also discarded.
 *
 * API endpoint:
 *   https://commons.wikimedia.org/w/api.php  (CORS open, origin=*)
 */

// ── Topic keyword filter ──────────────────────────────────────────────────────

// Kept as a named export for any external references.
export const RELEVANCE_WHITELIST = [
  'insect', 'bee', 'butterfly', 'moth', 'hoverfly', 'wasp', 'pollinator',
  'flora', 'plant', 'flower', 'prairie', 'wetland', 'habitat', 'wildlife',
  'bird', 'hummingbird', 'wisconsin', 'nature', 'botanical',
  'lepidoptera', 'hymenoptera', 'diptera', 'dragonfly', 'damselfly',
  'native', 'monarch', 'milkweed', 'clover', 'wildflower', 'meadow', 'garden',
];

// Applied against file titles and category names.
const CAT_KEYWORDS = new RegExp(
  '\\b(' + RELEVANCE_WHITELIST.join('|') + ')\\b',
  'i'
);

// ── Per-image filtering ───────────────────────────────────────────────────────

/**
 * Returns true when an image has a license and a usable thumbnail.
 * @param {object} page — raw page object from the MediaWiki API
 * @returns {boolean}
 */
export function isRelevant(page) {
  const ii = page.imageinfo?.[0];
  if (!ii) return false;
  if (!ii.extmetadata?.LicenseShortName?.value) return false;
  if (!ii.thumburl) return false;
  return true;
}

/**
 * Returns true when the file title or any of its Wikipedia categories matches
 * the pollinator / native-plant keyword set.
 * @param {object} page — raw page object (must have .title and .categories)
 * @returns {boolean}
 */
function _isTopicRelevant(page) {
  if (CAT_KEYWORDS.test(page.title ?? '')) return true;
  return (page.categories ?? []).some(c => CAT_KEYWORDS.test(c.title ?? ''));
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/**
 * Step 1: list=geosearch — returns up to `limit` file page IDs near the coord.
 * This API is reliable for namespace 6 (files), unlike generator=geosearch.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusM  metres (capped at 10 000 by the API)
 * @param {number} limit
 * @returns {Promise<Array<{pageid:number, lat:number, lon:number}>>}
 */
async function _geoSearch(lat, lng, radiusM, limit) {
  const params = new URLSearchParams({
    action:      'query',
    list:        'geosearch',
    gscoord:     `${lat}|${lng}`,
    gsradius:    String(Math.min(radiusM, 10000)),
    gsnamespace: '6',
    gslimit:     String(Math.min(limit, 500)),
    format:      'json',
    origin:      '*',
  });
  const resp = await fetch(`${COMMONS_API}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data?.query?.geosearch ?? [];
}

/**
 * Step 2: fetch imageinfo + categories + coordinates for a list of page IDs
 * (batched in chunks of 50 — the API maximum per request).
 *
 * @param {number[]} pageIds
 * @returns {Promise<object[]>}  raw page objects
 */
async function _fetchPageDetails(pageIds) {
  if (!pageIds.length) return [];
  const results = [];
  for (let i = 0; i < pageIds.length; i += 50) {
    const chunk = pageIds.slice(i, i + 50);
    const params = new URLSearchParams({
      action:     'query',
      pageids:    chunk.join('|'),
      prop:       'imageinfo|categories|coordinates',
      iiprop:     'url|extmetadata|dimensions',
      iiurlwidth: '400',
      cllimit:    'max',
      format:     'json',
      origin:     '*',
    });
    const resp = await fetch(`${COMMONS_API}?${params}`);
    if (!resp.ok) continue;
    const data = await resp.json();
    results.push(...Object.values(data?.query?.pages ?? {}));
  }
  return results;
}

/**
 * Fetches geotagged images near a [lng, lat] coordinate within radiusM metres.
 * Applies the license + topic relevance filter and returns up to maxResults images.
 *
 * @param {[number,number]} coord    [lng, lat]
 * @param {number}          radiusM  metres (max 10000)
 * @param {number}          [maxResults=20]
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsNear(coord, radiusM, maxResults = 20) {
  const [lng, lat] = coord;
  // Request more candidates than needed so filtering still yields enough results.
  const geoLimit = Math.min(maxResults * 4, 200);
  try {
    const geoHits = await _geoSearch(lat, lng, radiusM, geoLimit);
    if (!geoHits.length) return [];
    const pageIds = geoHits.map(r => r.pageid).filter(Boolean);
    const pages   = await _fetchPageDetails(pageIds);
    return pages
      .filter(p => isRelevant(p) && _isTopicRelevant(p))
      .slice(0, maxResults)
      .map(_normalise);
  } catch {
    return [];
  }
}

/**
 * Fetches geotagged images for the full app radius (15 km) for the map layer.
 * Uses a larger radius and higher limit; returns coordinates for marker placement.
 *
 * @param {[number,number]} center  [lng, lat] of the app center
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsForApp(center) {
  // gsradius max is 10000 m; the app radius is 15 km so we use 10 km here
  // to stay within the API limit and focus on the most relevant area.
  return fetchCommonsNear(center, 10000, 100);
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   pageId:      number,
 *   title:       string,
 *   thumburl:    string,
 *   thumbwidth:  number,
 *   thumbheight: number,
 *   descurl:     string,
 *   description: string,
 *   artist:      string,
 *   license:     string,
 *   lat:         number,
 *   lng:         number,
 * }} CommonsImage
 */

function _normalise(page) {
  const ii  = page.imageinfo?.[0] ?? {};
  const ext = ii.extmetadata ?? {};
  // Strip HTML tags from description / artist (Commons often embeds markup)
  const stripHtml = s => String(s ?? '').replace(/<[^>]*>/g, '').trim();
  return {
    pageId:      page.pageid,
    title:       (page.title ?? '').replace(/^File:/, ''),
    thumburl:    ii.thumburl   ?? '',
    thumbwidth:  ii.thumbwidth ?? 400,
    thumbheight: ii.thumbheight ?? 300,
    descurl:     ii.descriptionurl ?? '',
    description: stripHtml(ext.ImageDescription?.value) || (page.title ?? '').replace(/^File:/, ''),
    artist:      stripHtml(ext.Artist?.value)            || 'Unknown',
    license:     stripHtml(ext.LicenseShortName?.value)  || '',
    lat:         page.coordinates?.[0]?.lat ?? 0,
    lng:         page.coordinates?.[0]?.lon ?? 0,
  };
}
