/**
 * commons.js — Wikimedia Commons geotagged photography integration.
 *
 * Strategy: generator=search with pollinator keywords → filter by proximity
 * to the app center.  This avoids the generator=geosearch bug that silently
 * returns no pages for namespace 6 (files) even when matching photos exist.
 *
 * Two properties are fetched together in a single call:
 *   prop=imageinfo    — image URLs, license, EXIF metadata
 *   prop=coordinates  — {{Location}} template coordinates on the file page
 *
 * Coordinates are extracted from (in priority order):
 *   1. prop=coordinates  ({{Location}} template — most reliable)
 *   2. extmetadata GPSLatitude / GPSLongitude  (EXIF GPS)
 *
 * Images with no extractable coordinates, no license, or no thumbnail
 * are silently discarded.
 *
 * API endpoint:
 *   https://commons.wikimedia.org/w/api.php  (CORS open, origin=*)
 */

// ── Search query ──────────────────────────────────────────────────────────────

// OR-separated keyword terms — matches the working query the user validated.
const SEARCH_QUERY = 'bee|bees|butterfly|butterflies|moth|pollinator|honeybee|bumblebee';

// ── Exported whitelist (kept for any external references) ─────────────────────

export const RELEVANCE_WHITELIST = [
  'insect', 'bee', 'butterfly', 'moth', 'hoverfly', 'wasp', 'pollinator',
  'flora', 'plant', 'flower', 'prairie', 'wetland', 'habitat', 'wildlife',
  'bird', 'hummingbird', 'wisconsin', 'nature', 'botanical',
  'lepidoptera', 'hymenoptera', 'diptera', 'dragonfly', 'damselfly',
  'native', 'monarch', 'milkweed', 'clover', 'wildflower', 'meadow', 'garden',
];

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

// ── Coordinate extraction ─────────────────────────────────────────────────────

/**
 * Extracts lat/lng from a raw page object.
 * Tries prop=coordinates ({{Location}} template) first, then EXIF GPS tags.
 *
 * @param {object} page
 * @returns {{lat:number, lng:number}|null}
 */
function _extractCoords(page) {
  const coord = page.coordinates?.[0];
  if (coord?.lat != null && coord?.lon != null) {
    return { lat: +coord.lat, lng: +coord.lon };
  }
  const ext = page.imageinfo?.[0]?.extmetadata ?? {};
  const lat  = parseFloat(ext.GPSLatitude?.value);
  const lng  = parseFloat(ext.GPSLongitude?.value);
  if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  return null;
}

// ── Distance ──────────────────────────────────────────────────────────────────

function _haversineKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
             * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';

/**
 * Searches Commons by pollinator keywords and paginates until targetCount
 * candidate pages have been collected or the API is exhausted.
 *
 * Each page object includes imageinfo (URL, extmetadata) and coordinates.
 *
 * @param {number} targetCount
 * @returns {Promise<object[]>}
 */
async function _searchPollinatorFiles(targetCount) {
  const pages = [];
  let continueOffset = 0;

  while (pages.length < targetCount) {
    const params = new URLSearchParams({
      action:       'query',
      generator:    'search',
      gsrsearch:    SEARCH_QUERY,
      gsrnamespace: '6',
      gsrlimit:     '500',
      gsroffset:    String(continueOffset),
      prop:         'imageinfo|coordinates',
      iiprop:       'url|extmetadata',
      iiurlwidth:   '400',
      format:       'json',
      origin:       '*',
    });

    const resp = await fetch(`${COMMONS_API}?${params}`);
    if (!resp.ok) break;
    const data  = await resp.json();
    const batch = Object.values(data?.query?.pages ?? {});
    pages.push(...batch);

    const nextOffset = data?.continue?.gsroffset;
    if (nextOffset == null || pages.length >= targetCount) break;
    continueOffset = nextOffset;
  }

  return pages;
}

/**
 * Fetches geotagged pollinator images near a [lng, lat] coordinate within
 * radiusM metres.  Images without coordinates, a license, or a thumbnail
 * are discarded.
 *
 * @param {[number,number]} coord    [lng, lat]
 * @param {number}          radiusM  metres
 * @param {number}          [maxResults=20]
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsNear(coord, radiusM, maxResults = 20) {
  const [lng, lat] = coord;
  const radiusKm   = radiusM / 1000;
  // Fetch enough candidates that filtering still yields maxResults.
  const targetCount = Math.min(maxResults * 12, 1500);
  try {
    const candidates = await _searchPollinatorFiles(targetCount);
    return candidates
      .filter(p => {
        const c = _extractCoords(p);
        return c !== null && _haversineKm(lat, lng, c.lat, c.lng) <= radiusKm;
      })
      .filter(isRelevant)
      .slice(0, maxResults)
      .map(_normalise);
  } catch {
    return [];
  }
}

/**
 * Fetches Commons pollinator photos for the full app area.
 * Uses the app's 15 km analysis radius.
 *
 * @param {[number,number]} center  [lng, lat] of the app center
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsForApp(center) {
  return fetchCommonsNear(center, 15000, 100);
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
  const ii       = page.imageinfo?.[0] ?? {};
  const ext      = ii.extmetadata ?? {};
  const coords   = _extractCoords(page);
  const stripHtml = s => String(s ?? '').replace(/<[^>]*>/g, '').trim();
  return {
    pageId:      page.pageid,
    title:       (page.title ?? '').replace(/^File:/, ''),
    thumburl:    ii.thumburl    ?? '',
    thumbwidth:  ii.thumbwidth  ?? 400,
    thumbheight: ii.thumbheight ?? 300,
    descurl:     ii.descriptionurl ?? '',
    description: stripHtml(ext.ImageDescription?.value) || (page.title ?? '').replace(/^File:/, ''),
    artist:      stripHtml(ext.Artist?.value)            || 'Unknown',
    license:     stripHtml(ext.LicenseShortName?.value)  || '',
    lat:         coords?.lat ?? 0,
    lng:         coords?.lng ?? 0,
  };
}
