/**
 * commons.js — Wikimedia Commons geotagged photography integration.
 *
 * Two-pass approach:
 *   Pass 1 — geosearch by radius via the Commons MediaWiki API (CORS open).
 *   Pass 2 — client-side relevance filter: keep only images whose categories,
 *             description, or filename contain a word from RELEVANCE_WHITELIST.
 *
 * API endpoint:
 *   https://commons.wikimedia.org/w/api.php
 *   action=query &generator=geosearch &ggsprimary=all &ggsnamespace=6
 *   &ggsradius=N &ggscoord=LAT|LNG &prop=imageinfo
 *   &iiprop=url|extmetadata|dimensions &iiurlwidth=400 &format=json &origin=*
 *
 * Images missing a license field in extmetadata are silently discarded.
 */

// ── Relevance whitelist ───────────────────────────────────────────────────────

export const RELEVANCE_WHITELIST = [
  'insect', 'bee', 'butterfly', 'moth', 'hoverfly', 'wasp', 'pollinator',
  'flora', 'plant', 'flower', 'prairie', 'wetland', 'habitat', 'wildlife',
  'bird', 'hummingbird', 'wisconsin', 'nature', 'botanical',
  'lepidoptera', 'hymenoptera', 'diptera', 'dragonfly', 'damselfly',
  'native', 'monarch', 'milkweed', 'clover', 'wildflower', 'meadow', 'garden',
];

const _WL_REGEX = new RegExp(
  '\\b(' + RELEVANCE_WHITELIST.join('|') + ')\\b',
  'i'
);

// ── Per-image filtering ───────────────────────────────────────────────────────

/**
 * Returns true if an image passes the two-pass relevance filter.
 * @param {object} img  — a raw page object from the geosearch generator result
 * @returns {boolean}
 */
export function isRelevant(img) {
  const ii     = img.imageinfo?.[0];
  if (!ii) return false;
  // Require a license
  if (!ii.extmetadata?.LicenseShortName?.value) return false;
  // Reject no-thumbnail images
  if (!ii.thumburl) return false;

  const cats  = ii.extmetadata?.Categories?.value      ?? '';
  const desc  = ii.extmetadata?.ImageDescription?.value ?? '';
  const title = img.title ?? '';
  return _WL_REGEX.test(cats) || _WL_REGEX.test(desc) || _WL_REGEX.test(title);
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/**
 * Fetches geotagged images near a [lng, lat] coordinate within radiusM metres.
 * Applies the relevance filter and returns up to maxResults images.
 *
 * @param {[number,number]} coord    [lng, lat]
 * @param {number}          radiusM  metres (max 10000)
 * @param {number}          [maxResults=20]
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsNear(coord, radiusM, maxResults = 20) {
  const [lng, lat] = coord;
  const params = new URLSearchParams({
    action:       'query',
    generator:    'geosearch',
    ggsprimary:   'all',
    ggsnamespace: '6',
    ggsradius:    String(Math.min(radiusM, 10000)),
    ggscoord:     `${lat}|${lng}`,
    ggsglimit:    '50',
    prop:         'imageinfo',
    iiprop:       'url|extmetadata|dimensions',
    iiurlwidth:   '400',
    format:       'json',
    origin:       '*',
  });

  try {
    const resp = await fetch(`${COMMONS_API}?${params.toString()}`);
    if (!resp.ok) return [];
    const data  = await resp.json();
    const pages = Object.values(data?.query?.pages ?? {});
    return pages.filter(isRelevant).slice(0, maxResults).map(_normalise);
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
  // ggsradius max is 10000 m; the app radius is 15 km so we use 10 km here
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
