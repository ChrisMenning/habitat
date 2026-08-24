/**
 * commons.js — Wikimedia Commons geotagged photography integration.
 *
 * Strategy: generator=geosearch (location-first) → filter by license + thumbnail.
 * The Wikimedia geosearch API (list=geosearch / generator=geosearch) finds all
 * geotagged files within a radius of a coordinate — guaranteed to return local
 * results.  The previous keyword-search-global approach returned zero results
 * because it searched worldwide and hoped some matched the study area.
 *
 * API limit: gsradius / ggsradius max = 10,000 m.  To cover the full 15 km
 * analysis radius, we run five overlapping queries: one at the centre and four
 * offset by ~8 km in cardinal directions, then deduplicate by pageId.
 *
 * Two properties are fetched together in a single call:
 *   prop=imageinfo    — image URLs, license, EXIF metadata
 *   prop=coordinates  — {{Location}} template coordinates on the file page
 *
 * Coordinates are extracted from (in priority order):
 *   1. prop=coordinates  ({{Location}} template — most reliable)
 *   2. extmetadata GPSLatitude / GPSLongitude  (EXIF GPS)
 *
 * Images with no license or no thumbnail are silently discarded.
 *
 * API endpoint:
 *   https://commons.wikimedia.org/w/api.php  (CORS open, origin=*)
 */

// ── Relevance filtering ───────────────────────────────────────────────────────
//
// Images are checked against the filename, ImageDescription extmetadata, and
// the pipe-separated Categories extmetadata field (all included in the API
// response via iiprop=extmetadata).
//
// Logic: reject first → require positive match.
//
// REJECT_TERMS — if any term matches, the image is excluded regardless.
// INCLUDE_TERMS — at least one must match for an image to be accepted.
//
// Plurals and key variants are listed explicitly so word-boundary matching
// (\\b…\\b) stays precise (e.g. "bee" must not match "been").

const _REJECT_TERMS = [
  // Sports & venues
  'packers', 'badgers', 'lambeau', 'titletown', 'nfl', 'nhl', 'nba',
  'football', 'basketball', 'baseball', 'hockey', 'soccer', 'volleyball',
  'stadium', 'arena', 'bleacher',
  // Commercial / urban / events
  'restaurant', 'brewery', 'tavern', 'casino', 'nightclub',
  'parade', 'concert', 'graduation', 'wedding', 'headshot', 'mugshot',
  // Explicit non-nature infrastructure
  'expressway', 'overpass', 'interchange',
];

const _INCLUDE_TERMS = [
  // ── Bees (Hymenoptera: Apidae, Halictidae, etc.) ───────────────────────────
  'bee', 'bees', 'beekeeper', 'beekeeping', 'beehive',
  'bumblebee', 'bumblebees', 'bumble bee', 'bumble bees',
  'honeybee', 'honeybees', 'honey bee', 'honey bees',
  'sweat bee', 'sweat bees', 'mason bee', 'mason bees',
  'leafcutter', 'leafcutters', 'carpenter bee', 'carpenter bees',
  'mining bee', 'mining bees', 'digger bee', 'digger bees',
  'cuckoo bee', 'cuckoo bees', 'plasterer bee',
  'halictid', 'andrenid', 'colletid', 'melittid',
  // Genera
  'bombus', 'apis', 'xylocopa', 'anthophora', 'osmia', 'megachile',
  'agapostemon', 'lasioglossum', 'nomada', 'ceratina', 'augochlora',
  'halictus', 'dialictus', 'melissodes', 'eucera',
  // ── Butterflies & moths (Lepidoptera) ─────────────────────────────────────
  'butterfly', 'butterflies', 'moth', 'moths', 'skipper', 'skippers',
  'caterpillar', 'caterpillars', 'chrysalis', 'cocoon', 'larvae',
  'monarch butterfly', 'monarch butterflies', 'viceroy', 'viceroys',
  'swallowtail', 'swallowtails', 'fritillary', 'fritillaries',
  'sulphur butterfly', 'orange sulphur', 'clouded sulphur',
  'hairstreak', 'hairstreaks', 'azure', 'azures',
  'painted lady', 'red admiral', 'question mark butterfly',
  'eastern tiger', 'spicebush swallowtail', 'black swallowtail',
  'cabbage white', 'mustard white',
  'buckeye', 'hackberry emperor', 'tawny emperor',
  'pearl crescent', 'silver-spotted skipper', 'least skipper',
  'sphinx moth', 'hawk moth', 'clearwing moth', 'tiger moth',
  'luna moth', 'cecropia moth', 'polyphemus moth',
  // Genera / families
  'danaus', 'papilio', 'vanessa', 'pieris', 'colias', 'speyeria',
  'limenitis', 'lycaena', 'celastrina',
  'lepidoptera',
  // ── Other insects & invertebrates ─────────────────────────────────────────
  'hoverfly', 'hoverflies', 'hover fly', 'hover flies',
  'syrphid', 'syrphidae', 'syrphus', 'eristalis',
  'wasp', 'wasps', 'yellowjacket', 'yellowjackets', 'yellow jacket',
  'hornet', 'hornets', 'mud dauber', 'paper wasp',
  'beetle', 'beetles', 'longhorn beetle', 'soldier beetle',
  'blister beetle', 'goldenrod beetle', 'rose chafer',
  'firefly', 'fireflies', 'lightning bug', 'lightning bugs',
  'dragonfly', 'dragonflies', 'damselfly', 'damselflies', 'odonata',
  'insect', 'insects', 'invertebrate', 'invertebrates',
  'hymenoptera', 'diptera', 'coleoptera', 'hemiptera',
  'pollinator', 'pollinators', 'pollination', 'pollinating',
  // ── Native plants & flowers ────────────────────────────────────────────────
  'milkweed', 'milkweeds', 'common milkweed', 'swamp milkweed',
  'butterfly weed', 'butterflyweed',
  'goldenrod', 'goldenrods', 'solidago',
  'coneflower', 'coneflowers', 'echinacea', 'rudbeckia',
  'black-eyed susan', 'black eyed susan',
  'prairie clover', 'purple prairie clover', 'white prairie clover',
  'liatris', 'blazing star', 'blazingstar',
  'bee balm', 'wild bergamot', 'monarda', 'bergamot',
  'anise hyssop', 'agastache',
  'mountain mint', 'pycnanthemum',
  'ironweed', 'vernonia',
  'boneset', 'eupatorium', 'joe-pye weed', 'joe pye weed', 'eutrochium',
  'aster', 'asters', 'symphyotrichum', 'new england aster',
  'sunflower', 'sunflowers', 'helianthus',
  'compass plant', 'silphium', 'cup plant', 'prairie dock',
  'wild lupine', 'lupine', 'lupines', 'baptisia',
  'trillium', 'hepatica', 'bloodroot', 'sanguinaria',
  'columbine', 'aquilegia', 'shooting star',
  'prairie smoke', 'geum triflorum',
  'wild ginger', 'asarum',
  'cardinal flower', 'lobelia',
  'blue flag iris', 'yellow flag iris',
  'native plant', 'native plants', 'native flower', 'native flowers',
  'native vegetation', 'native species',
  'wildflower', 'wildflowers', 'wild flower', 'wild flowers',
  'prairie flower', 'prairie grass', 'prairie plants',
  'clover', 'clovers', 'red clover', 'white clover', 'trefoil',
  'thistle', 'thistles', 'cirsium',
  'phacelia', 'borage', 'fennel',
  'flower', 'flowers', 'flowering plant', 'forb', 'forbs',
  // ── Habitats & landscapes ──────────────────────────────────────────────────
  'prairie', 'prairies', 'tallgrass prairie', 'tallgrass',
  'meadow', 'meadows', 'grassland', 'grasslands',
  'wetland', 'wetlands', 'marsh', 'marshes', 'bog', 'bogs', 'fen', 'fens',
  'swamp', 'swamps', 'sedge meadow',
  'savanna', 'savannas', 'oak savanna', 'oak barrens',
  'forest edge', 'woodland edge', 'woodland clearing', 'hedgerow',
  'pollinator garden', 'butterfly garden', 'native garden',
  'rain garden', 'bioswale', 'green roof',
  'wildlife sanctuary', 'wildlife refuge', 'nature preserve',
  'nature area', 'natural area', 'state natural area', 'natural history',
  'conservation area', 'conservation land',
  'habitat restoration', 'restored habitat', 'restoration project',
  'protected land', 'protected area', 'green corridor',
  'nature', 'natural habitat', 'wildlife habitat', 'habitat',
  'wildlife', 'sanctuary', 'refuge', 'reserve', 'preserve',
  'arboretum', 'botanical garden', 'nature center',
  // ── Local / regional identifiers ──────────────────────────────────────────
  'bay beach wildlife', 'bay beach',
  'cofrin arboretum', 'cofrin',
  'point au sable', 'bay de noc',
  'lower fox river',
  'brown county', 'brown county park', 'brown county forest',
  'reforestation camp', 'sensiba',
  'barkhausen', 'point beach', 'kohler', 'kettle moraine',
  // ── Birds & other wildlife (habitat indicators) ───────────────────────────
  'hummingbird', 'hummingbirds', 'ruby-throated hummingbird',
  'bat', 'bats', 'little brown bat', 'big brown bat',
  'frog', 'frogs', 'toad', 'toads', 'tree frog', 'chorus frog',
  'salamander', 'salamanders', 'turtle', 'turtles',
  'hawk', 'kestrel', 'bluebird', 'warbler', 'warblers',
  'great blue heron', 'sandhill crane', 'whooping crane',
  // ── Threats & harm to pollinators / habitat ───────────────────────────────
  'pesticide', 'pesticides', 'herbicide', 'herbicides',
  'insecticide', 'insecticides', 'neonicotinoid', 'neonicotinoids',
  'fungicide', 'fungicides',
  'invasive species', 'invasive plant', 'invasive plants',
  'invasive weed', 'invasive weeds',
  'buckthorn', 'common buckthorn', 'glossy buckthorn',
  'garlic mustard', 'alliaria petiolata',
  'purple loosestrife', 'lythrum salicaria',
  'phragmites', 'common reed',
  'reed canary grass', 'phalaris arundinacea',
  'japanese knotweed', 'japanese barberry',
  'multiflora rose', 'rosa multiflora',
  'leafy spurge', 'spotted knapweed',
  'emerald ash borer', 'asian longhorn beetle', 'spongy moth',
  'colony collapse', 'habitat loss', 'habitat fragmentation',
  'deforestation', 'urban sprawl', 'land clearing',
  // ── Ecology & science ─────────────────────────────────────────────────────
  'entomology', 'entomologist',
  'botany', 'botanist', 'botanical',
  'ecology', 'ecologist', 'ecological',
  'biodiversity', 'conservation biology',
  'phenology', 'foraging', 'nesting',
  'pollen', 'nectar', 'nectary',
  'flora', 'fauna',
];

// Pre-compile patterns once at module load (case-insensitive, word-boundary).
// Spaces in multi-word terms are replaced with [\s_]+ to also match filenames
// like "Bee_on_flower.jpg" where underscores stand in for spaces.
function _buildPattern(terms) {
  const escaped = terms.map(t =>
    t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_]+')
  );
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'i');
}
const _rejectRe  = _buildPattern(_REJECT_TERMS);
const _includeRe = _buildPattern(_INCLUDE_TERMS);

/**
 * Builds a single searchable text string from the page's title, image
 * description, and Commons categories (all available via extmetadata).
 */
function _pageText(page) {
  const ii  = page.imageinfo?.[0] ?? {};
  const ext = ii.extmetadata ?? {};
  const strip = s => String(s ?? '').replace(/<[^>]*>/g, '');
  const title       = strip(page.title ?? '').replace(/^File:/i, '').replace(/_/g, ' ');
  const description = strip(ext.ImageDescription?.value);
  const categories  = strip(ext.Categories?.value).replace(/[|★]/g, ' ');
  return `${title} ${description} ${categories}`;
}

/**
 * Returns true when an image is topically relevant to pollinators, native
 * plants, habitat, or ecological threats — and has a license + thumbnail.
 * @param {object} page — raw page object from the MediaWiki API
 * @returns {boolean}
 */
export function isRelevant(page) {
  const ii = page.imageinfo?.[0];
  if (!ii) return false;
  if (!ii.extmetadata?.LicenseShortName?.value) return false;
  if (!ii.thumburl) return false;
  const text = _pageText(page);
  if (_rejectRe.test(text)) return false;
  return _includeRe.test(text);
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
const GEO_MAX_RADIUS = 10000; // Wikimedia API hard limit (metres)

/**
 * Runs a single generator=geosearch query at (lat, lng) with up to 500 results.
 * Paginates until maxPages batches have been collected or the API is exhausted.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusM  — clamped to GEO_MAX_RADIUS
 * @param {number} [maxPages=3]
 * @returns {Promise<object[]>}
 */
async function _geosearchFiles(lat, lng, radiusM, maxPages = 3) {
  const radius = Math.min(Math.round(radiusM), GEO_MAX_RADIUS);
  const pages  = [];
  let continueParam = null;
  let pagesFetched  = 0;

  while (pagesFetched < maxPages) {
    const params = new URLSearchParams({
      action:       'query',
      generator:    'geosearch',
      ggscoord:     `${lat}|${lng}`,
      ggsradius:    String(radius),
      ggsnamespace: '6',
      ggslimit:     '500',
      prop:         'imageinfo|coordinates',
      iiprop:       'url|extmetadata',
      iiurlwidth:   '400',
      format:       'json',
      origin:       '*',
    });
    if (continueParam) {
      for (const [k, v] of Object.entries(continueParam)) params.set(k, v);
    }

    const resp = await fetch(`${COMMONS_API}?${params}`);
    if (!resp.ok) break;
    const data  = await resp.json();
    const batch = Object.values(data?.query?.pages ?? {});
    pages.push(...batch);
    pagesFetched++;

    if (!data.continue) break;
    continueParam = data.continue;
  }

  return pages;
}

/**
 * Fetches geotagged images near a [lng, lat] coordinate within radiusM metres.
 * Uses geosearch (location-first).  When radiusM > GEO_MAX_RADIUS, runs five
 * overlapping queries (centre + 4 cardinal offsets at ~8 km) to improve coverage.
 *
 * Images without a license or thumbnail are discarded.
 *
 * @param {[number,number]} coord    [lng, lat]
 * @param {number}          radiusM  metres
 * @param {number}          [maxResults=20]
 * @returns {Promise<CommonsImage[]>}
 */
export async function fetchCommonsNear(coord, radiusM, maxResults = 20) {
  const [lng, lat] = coord;
  const radiusKm   = radiusM / 1000;

  try {
    // Always query the centre point
    const queryPoints = [[lat, lng]];

    // For radii > 10 km, add four offset centres to cover the outer ring
    if (radiusM > GEO_MAX_RADIUS) {
      const offsetKm = 8;
      const dLat = offsetKm / 111.32;
      const dLng = offsetKm / (111.32 * Math.cos(lat * Math.PI / 180));
      queryPoints.push(
        [lat + dLat, lng],
        [lat - dLat, lng],
        [lat, lng + dLng],
        [lat, lng - dLng],
      );
    }

    // Run all geosearch queries in parallel
    const batches = await Promise.all(
      queryPoints.map(([qLat, qLng]) => _geosearchFiles(qLat, qLng, GEO_MAX_RADIUS))
    );

    // Merge and deduplicate by pageId
    const seen      = new Set();
    const candidates = [];
    for (const batch of batches) {
      for (const page of batch) {
        if (!seen.has(page.pageid)) {
          seen.add(page.pageid);
          candidates.push(page);
        }
      }
    }

    return candidates
      .filter(isRelevant)
      .filter(p => {
        const c = _extractCoords(p);
        return c != null && _haversineKm(lat, lng, c.lat, c.lng) <= radiusKm;
      })
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
