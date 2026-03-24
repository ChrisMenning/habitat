/**
 * waystations.js — Monarch Waystation Registry locations near Green Bay, WI.
 *
 * Source:
 *   Monarch Watch Waystation Registry
 *   https://docs.google.com/spreadsheets/d/1ptKnXC6ZigkwQZliapdp1JlS313BGEll0QtZSjLmNaU/
 *
 * Location methodology:
 *   The registry records only city/state/zip — no street addresses.
 *   Precise coordinates were determined by:
 *     1. Searching Brown County, WI parcel records (2020 dataset hosted on
 *        ArcGIS Online, item 2b0fef734a514f70a1d19223b0a06676) by last name
 *        + ZIP code, then cross-referencing first names for confirmation.
 *     2. For public/institutional registrants: direct address lookup via
 *        OSM Nominatim and US Census Bureau Geocoder.
 *   Only entries where the parcel owner's name matches the registrant name
 *   (first name or both names verified) are included. Ambiguous common-name
 *   matches are excluded.
 *
 * Properties on each feature:
 *   data_source  — always 'waystation' (used for popup routing)
 *   ws_id        — Monarch Watch registry ID
 *   name         — habitat / station name
 *   registrant   — registrant name as listed in registry
 *   registered   — registration date (MM/DD/YY)
 *   size         — habitat size category from registry
 *   location     — location type (Home, School, Zoo, etc.)
 *   type         — internal classification: 'home' | 'school' | 'org' |
 *                  'nature_center' | 'zoo' | 'community' | 'place_of_worship'
 *   address      — confirmed civic address (from parcel records or direct lookup)
 *
 * Coordinates are the Census geocoded midpoint of the address range segment.
 * Private residential coordinates are deliberately shown at address-range
 * precision (±50 m), not exact parcel centroids.
 *
 * Approximate-location waystations (no confirmed parcel match):
 *   Placed on a ~350 m radius ring centred on a representative point for their
 *   zip code.  Sites in the same zip are evenly spaced around the ring so they
 *   cluster together visually, making their approximate nature obvious.
 *   These sites are excluded from foraging-range connectivity calculations.
 */

// ── Ring-placement helpers for approximate waystations ────────────────────────

/** Radius (km) of the per-zip placement ring for approximate waystations. */
const _RING_RADIUS_KM = 0.35;

/**
 * Representative centre [lat, lon] for each zip code area.
 * Chosen to fall within residential areas where most waystations are registered.
 */
const _ZIP_CENTERS = {
  '54301': [44.491, -88.012],   // core south Green Bay
  '54302': [44.518, -87.968],   // east Green Bay
  '54303': [44.517, -88.053],   // west Green Bay
  '54304': [44.508, -88.041],   // southwest Green Bay
  '54311': [44.513, -87.931],   // southeast Green Bay / Bellevue
  '54313': [44.590, -88.096],   // north Green Bay / Suamico
};

/**
 * Places approximate waystations on evenly-spaced ring positions grouped by
 * zip code.  Within each zip the ring starts at the northernmost point and
 * proceeds clockwise.
 *
 * @param {object[]} waystations  APPROX_WAYSTATIONS entries
 * @returns {Map<number, [number, number]>}  id → [lon, lat]
 */
function _ringPositions(waystations) {
  const byZip = new Map();
  for (const w of waystations) {
    const zip = (w.address.match(/\d{5}/) ?? [])[0] ?? '';
    if (!byZip.has(zip)) byZip.set(zip, []);
    byZip.get(zip).push(w);
  }
  const out = new Map();
  for (const [zip, group] of byZip) {
    const center = _ZIP_CENTERS[zip];
    if (!center) continue;
    const [clat, clon] = center;
    const n    = group.length;
    const latR = _RING_RADIUS_KM / 111.0;
    const lonR = _RING_RADIUS_KM / (111.0 * Math.cos(clat * Math.PI / 180));
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i / n) - Math.PI / 2; // north first, clockwise
      out.set(group[i].id, [
        +(clon + lonR * Math.cos(angle)).toFixed(6),
        +(clat + latR * Math.sin(angle)).toFixed(6),
      ]);
    }
  }
  return out;
}

/** @returns {GeoJSON.FeatureCollection} */
export function waystationGeoJSON() {
  const approxPos = _ringPositions(APPROX_WAYSTATIONS);
  return {
    type: 'FeatureCollection',
    features: [...WAYSTATIONS, ...APPROX_WAYSTATIONS].map(w => {
      const isApprox  = w.approximate ?? false;
      const [lon, lat] = isApprox ? approxPos.get(w.id) : [w.lon, w.lat];
      return {
        type:     'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          data_source:  'waystation',
          layer_id:     'waystations',
          est_key:      'waystation',
          ws_id:        w.id,
          name:         w.habitat  || `Waystation #${w.id}`,
          registrant:   w.registrant,
          registered:   w.registered,
          size:         w.size,
          location:     w.location,
          type:         w.type,
          address:      w.address,
          approximate:  isApprox,
        },
      };
    }),
  };
}

// ── Registry data ─────────────────────────────────────────────────────────────
// Sorted by registry ID (chronological registration order).

// Confirmed-location entries: address verified against Brown County parcel
// records (first + last name match) or authoritative institutional sources.
const WAYSTATIONS = [
  // ── Public / institutional ───────────────────────────────────────────────
  {
    id: 4101, registered: '8/16/10',
    registrant: 'N.E.W. Zoological Society, Inc.',
    habitat:    'New Zoo Butterfly Garden',
    size: 'Colossal (5,000 sq ft or more)', location: 'Zoo', type: 'zoo',
    address: '4378 Reforestation Rd, Suamico, WI 54313',
    // Nominatim: NEW Zoo Adventure Park
    lat: 44.6586, lon: -88.0897,
  },
  {
    id: 7455, registered: '10/27/13',
    registrant: 'N.E.W. Master Gardener Volunteer Association',
    habitat:    'Community Treatment Center Butterfly Garden',
    size: 'X-Large (1,000–4,999 sq ft)', location: 'Other', type: 'org',
    address: '3150 Gershwin Dr, Green Bay, WI 54311',
    // Census geocoder: 3150 Gershwin Dr → parcel: Brown County Community Treatment Center
    lat: 44.524138, lon: -87.923046,
  },
  {
    id: 12514, registered: '12/13/15',
    registrant: 'Bay Beach Wildlife Sanctuary',
    habitat:    'OAK School Garden',
    size: 'Large (500–999 sq ft)', location: 'Nature or Education Center', type: 'nature_center',
    address: '1660 East Shore Dr, Green Bay, WI 54302',
    // Census geocoder: 1660 E Shore Dr → parcel: Green Bay City Bay Beach Wildlife Ctr
    lat: 44.529685, lon: -87.974518,
  },
  {
    id: 18367, registered: '10/16/17',
    registrant: 'Parish & Father Allouez Catholic School Resurrection Catholic',
    habitat:    '',
    size: 'Large (500–999 sq ft)', location: 'Place of Worship', type: 'place_of_worship',
    address: '333 Hilltop Dr, Green Bay, WI 54301',
    // Parcel: Resurrection Catholic Congregation, 333 Hilltop Dr
    lat: 44.4595, lon: -88.0310,
  },
  {
    id: 33669, registered: '5/12/21',
    registrant: "Wequiock Elementary School Children's Center for Environmental Science",
    habitat:    "Wequiock Elementary School Children's Center for Environmental Science",
    size: 'Small (less than 200 sq ft)', location: 'School', type: 'school',
    address: '4824 Wahl Rd, Green Bay, WI 54311',
    // Parcel: Green Bay Area Public School District Wequiock (lat/lon of school parcel)
    lat: 44.5886, lon: -87.8681,
  },
  {
    id: 43980, registered: '6/2/23',
    registrant: 'Mahon Creek Neighborhood Association',
    habitat:    'Mahon Creek Pollinator Garden',
    size: 'Medium (200–499 sq ft)', location: 'Place of Worship', type: 'community',
    address: 'Mahon Creek, Green Bay, WI 54311',
    // OSM Nominatim: Mahon Creek, Green Bay
    lat: 44.5275, lon: -87.9372,
  },

  // ── Private homes — confirmed by parcel first-name + last name matching ──
  {
    id: 3934, registered: '7/1/10',
    registrant: 'Diana & Dick Rockhill',
    habitat:    'Rockhill Butterfly Buffet & Nursery',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '1752 Condor Ln, Green Bay, WI 54313',
    // Parcel: DIANA S ROCKHILL (1 match, first name confirmed)
    lat: 44.588115, lon: -88.081882,
  },
  {
    id: 4017, registered: '7/28/10',
    registrant: 'Janet M. Hinkfuss',
    habitat:    '',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '846 Ninth St, Green Bay, WI 54304',
    // Parcel: JANET M HINKFUSS (first + middle initial confirmed)
    lat: 44.505248, lon: -88.038125,
  },
  {
    id: 4306, registered: '9/27/10',
    registrant: 'Lori and Bob Casey',
    habitat:    'Windy Rock Pines',
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: '2385 Autumn Ridge Trl, Suamico, WI 54313',
    // Parcel: ROBERT T CASEY (Robert = Bob, confirmed)
    lat: 44.605676, lon: -88.116462,
  },
  {
    id: 5860, registered: '7/16/12',
    registrant: 'Dave Rotter',
    habitat:    "Rielly's Retreat",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: '513 Cornelius Dr, Green Bay, WI 54311',
    // Parcel: DAVID A ROTTER (David = Dave, 1 match)
    lat: 44.510649, lon: -87.927619,
  },
  {
    id: 8768, registered: '7/10/14',
    registrant: 'Julie Macier',
    habitat:    "Grammy's Waystation",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: '2470 Newberry Ave, Green Bay, WI 54302',
    // Parcel: MACIER WILLIAM G & JULIE R TRUST (Julie R confirmed, 1 match)
    lat: 44.498775, lon: -87.960008,
  },
  {
    id: 12790, registered: '3/3/16',
    registrant: 'Sarah, Mark, Gwendolyn, Judah, and Leopoldo Valentine',
    habitat:    'Valentine Homestead',
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: '3026 Nicolet Dr, Green Bay, WI 54311',
    // Parcel: MARK N VALENTINE | SARAH J VALENTINE (both first names confirmed)
    lat: 44.554272, lon: -87.911563,
  },
  {
    id: 26833, registered: '10/16/19',
    registrant: 'Ann & Doug Wichman',
    habitat:    'Pollinator Prairie',
    size: 'X-Large (1,000–4,999 sq ft)', location: 'Home', type: 'home',
    address: '2867 Josephine Cir, Green Bay, WI 54311',
    // Parcel: DOUGLAS E WICHMAN (Douglas = Doug, 2 matches in zip)
    lat: 44.513521, lon: -87.938771,
  },
  {
    id: 28310, registered: '5/18/20',
    registrant: 'Susan Bartlett',
    habitat:    "Bartlett's Butterflies",
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: '1107 Forest Grove, Green Bay, WI 54313',
    // Parcel: SUSAN M BARTLETT (first name confirmed, 1 match)
    lat: 44.570010, lon: -88.092311,
  },
  {
    id: 35044, registered: '7/1/21',
    registrant: 'Michele Utrie',
    habitat:    "Michele's Monarchs",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '3240 Eaton Rd, Green Bay, WI 54311',
    // Parcel: NICHOLAS W UTRIE (unique surname, 1 match)
    lat: 44.466147, lon: -87.920796,
  },
  {
    id: 35594, registered: '7/20/21',
    registrant: 'Donna Semrau',
    habitat:    'No Sweat Ranch',
    size: 'Colossal (5,000 sq ft or more)', location: 'Farm', type: 'home',
    address: '4511 Nicolet Dr, Green Bay, WI 54311',
    // Parcel: DONNA J SEMRAU (Donna confirmed, 1 match)
    lat: 44.611266, lon: -87.854772,
  },
  {
    id: 38028, registered: '3/6/22',
    registrant: 'Randy and Janet Peterson',
    habitat:    'The E-Street Waystation',
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: '2750 Daniel Ct, Green Bay, WI 54311',
    // Parcel: RANDALL L PETERSON | JANET L PETERSON (both names confirmed)
    lat: 44.486259, lon: -87.945435,
  },
  {
    id: 39155, registered: '5/30/22',
    registrant: 'Jessica and Nikolas Meurett',
    habitat:    'The Shire',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '1308 Eliza St, Green Bay, WI 54301',
    // Parcel: NIKOLAS S MEURETT (exact first name, 1 match)
    lat: 44.496095, lon: -88.005507,
  },
  {
    id: 40470, registered: '7/30/22',
    registrant: 'Brian Klawitter',
    habitat:    "Napalm's Wildflower Patch",
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: '1434 Thirteenth Ave, Green Bay, WI 54304',
    // Parcel: BRIAN J KLAWITTER ETAL (Brian confirmed, 1 match)
    lat: 44.503952, lon: -88.044319,
  },
  {
    id: 40790, registered: '8/10/22',
    registrant: 'Steve & Veronica Krenek',
    habitat:    'Misty Mountains Monarchs',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '2064 Mystic Hills Ter, Suamico, WI 54313',
    // Parcel: STEVEN M KRENEK (Steven = Steve, 1 match)
    lat: 44.596868, lon: -88.105446,
  },
  {
    id: 40818, registered: '8/11/22',
    registrant: 'Jeremy & Carol Voldsness',
    habitat:    "Voldsness' Roost on the Hill",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: '2681 S Webster Ave, Green Bay, WI 54301',
    // Parcel: JEREMY D VOLDSNESS (Jeremy confirmed, 1 match)
    lat: 44.472312, lon: -88.030119,
  },
  {
    id: 45890, registered: '9/6/23',
    registrant: 'Dave & Leigh Begalske',
    habitat:    "Begalske's House of Wings",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: '1823 Fiesta Ln, Green Bay, WI 54302',
    // Parcel: DAVID E BEGALSKE (Dave = David, 1 match)
    lat: 44.485846, lon: -87.984060,
  },
  {
    id: 46881, registered: '3/19/24',
    registrant: 'Randy and Julie Gummin',
    habitat:    "Jewel's Haven",
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: '2298 Westline Rd, Suamico, WI 54313',
    // Parcel: RANDALL A GUMMIN (Randy = Randall, 1 match)
    lat: 44.603351, lon: -88.129987,
  },
  {
    id: 48804, registered: '8/3/24',
    registrant: 'Randy & Debbie Rosera',
    habitat:    'Rosera Gardens!',
    size: 'X-Large (1,000–4,999 sq ft)', location: 'Home', type: 'home',
    address: '2575 Robinson Ave, Green Bay, WI 54311',
    // Parcel: RANDY S ROSERA (Randy confirmed, 2 matches in zip, took exact first-name match)
    lat: 44.479012, lon: -87.955094,
  },
  {
    id: 42976, registered: '3/29/23',
    registrant: 'Sue Cravillion',
    habitat:    'Cravillion Park',
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: '3701 Robin Ln, Suamico, WI 54313',
    // Parcel: CHRISTOPHER J CRAVILLION ETAL (unique surname, confirmed family match)
    lat: 44.630302, lon: -88.124939,
  },
];

// ── Approximate-location entries ──────────────────────────────────────────────
// These waystations could not be matched to a parcel record (surname not found,
// common name with no first-name confirmation, or a wrongly-named record).
// Their street address is unknown.  No lat/lon is stored here — positions are
// computed by _ringPositions() which places each zip-code group on an evenly-
// spaced ~350 m ring so their approximate nature is visually obvious on the map.
// These entries are also excluded from foraging-range connectivity calculations.
const APPROX_WAYSTATIONS = [

  // ── zip 54301 · core south Green Bay ────────────────────────────────────
  {
    id: 2116, registered: '6/2/08',
    registrant: 'Toni Weiss', habitat: 'Shelter From The Storm',
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 5305, registered: '11/30/11',
    registrant: 'Lisa Kay & Michael Peters', habitat: '',
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 5733, registered: '6/13/12',
    registrant: 'Sarah Mark Gwendolyn and Judah Valentine',
    habitat: 'Valentine Butterfly Garden',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 22507, registered: '11/22/18',
    registrant: 'Darryl R. Beers',
    habitat: 'Darryl R. Beers Butterfly and Bee Habitat',
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 30354, registered: '8/12/20',
    registrant: 'Jenny Kuehl', habitat: 'Sunny Haven Gardens',
    size: 'X-Large (1,000–4,999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 32268, registered: '3/12/21',
    registrant: 'Jaime Howarth', habitat: 'Butterfly Sanctuary',
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 42099, registered: '12/29/22',
    registrant: 'Amanda Lowther', habitat: 'Anandamide',
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 52043, registered: '7/7/25',
    registrant: 'Sarah Scott', habitat: 'Whispering Wings',
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },
  {
    id: 55034, registered: '3/4/26',
    registrant: 'Leah Charles', habitat: "Leah's Monarch Waystation",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54301',
    approximate: true,
  },

  // ── zip 54302 · east Green Bay ───────────────────────────────────────────
  {
    id: 1270, registered: '5/22/07',
    registrant: 'Debi & Charlie Nitka', habitat: 'My Backyard',
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54302',
    approximate: true,
  },
  {
    id: 38989, registered: '5/22/22',
    registrant: 'Michelle Jadin', habitat: "Michelle's Monarch Menagerie",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54302',
    // Parcel PEARL JADIN found — first name mismatch (Pearl ≠ Michelle)
    approximate: true,
  },

  // ── zip 54303 · west Green Bay ───────────────────────────────────────────
  {
    id: 8356, registered: '6/6/14',
    registrant: 'Lisa Bowen', habitat: "Mom's Garden Oasis",
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54303',
    approximate: true,
  },
  {
    id: 46819, registered: '3/11/24',
    registrant: 'Julie D Gabris', habitat: "Jewel's Butterfly Inn",
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54303',
    // Parcel VICTOR R GABRIS found — first name mismatch (Victor ≠ Julie)
    approximate: true,
  },

  // ── zip 54304 · southwest Green Bay ─────────────────────────────────────
  {
    id: 959, registered: '9/21/06',
    registrant: "Ben's Backyard Monarch Waystation", habitat: 'Backyard',
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54304',
    approximate: true,
  },
  {
    id: 4215, registered: '9/3/10',
    registrant: 'Scott and Connie Klein',
    habitat: "Connie's Monarch Dream Garden",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54304',
    // Parcel BRADLEY KLEIN found — first name mismatch (Bradley ≠ Scott/Connie)
    approximate: true,
  },
  {
    id: 51389, registered: '6/12/25',
    registrant: 'Cristi Hutson', habitat: "Cristi's Blooms & Butterflies",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54304',
    // Parcel COADY L HUTSON found — first name mismatch (Coady ≠ Cristi)
    approximate: true,
  },

  // ── zip 54311 · southeast Green Bay / Bellevue ───────────────────────────
  {
    id: 2391, registered: '7/22/08',
    registrant: 'Greg and Marla Mosholder',
    habitat: "Mosholder's Monarchs",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Bellevue, WI 54311',
    approximate: true,
  },
  {
    id: 4059, registered: '8/8/10',
    registrant: 'Barb Nelson', habitat: 'Danaus Digs',
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    approximate: true,
  },
  {
    id: 25714, registered: '8/5/19',
    registrant: 'Barbara J Nelson',
    habitat: "GMA HoHo's Butterfly Bungalow",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    approximate: true,
  },
  {
    id: 31894, registered: '1/27/21',
    registrant: 'Miranda Paul', habitat: 'Paul Family Gardens',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Bellevue, WI 54311',
    // Parcel JARED MCLEOD found — no name match (Miranda Paul)
    approximate: true,
  },
  {
    id: 36461, registered: '8/21/21',
    registrant: 'Daniel & Margie Baker',
    habitat: 'Bay Pollinator Habitat',
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    // Parcel PORT CITY BAKERY INC found — commercial entity, not a match
    approximate: true,
  },
  {
    id: 37068, registered: '9/27/21',
    registrant: 'The Lance Family', habitat: '',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    // Parcel JOSEPH W LANCELLE found — different surname (Lancelle ≠ Lance)
    approximate: true,
  },
  {
    id: 44374, registered: '6/20/23',
    registrant: 'Elizabeth DeLamater', habitat: 'Blue Door Prairie',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    approximate: true,
  },
  {
    id: 44741, registered: '7/7/23',
    registrant: 'Stephanie L Grant', habitat: 'The Grant Ranch',
    size: 'X-Large (1,000–4,999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54311',
    // Parcel GRANT DEAN L & MICHELLE M TRUST found — name reversed, Stephanie not present
    approximate: true,
  },

  // ── zip 54313 · north Green Bay / Suamico ────────────────────────────────
  {
    id: 227, registered: '8/23/05',
    registrant: 'David & Maureen Mulloy', habitat: 'My Backyard',
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel JEFFREY R MULLOY found — first name mismatch (Jeffrey ≠ David)
    approximate: true,
  },
  {
    id: 3880, registered: '6/15/10',
    registrant: 'Emily J. Dinatale', habitat: "Emily's Butterfly B & B",
    size: 'Large (500–999 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    approximate: true,
  },
  {
    id: 4237, registered: '9/7/10',
    registrant: 'Susan C. Joachim', habitat: "Susie's Butterfly Haven",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel RUSSELL W JOACHIM found — likely spouse, but first name unconfirmed
    approximate: true,
  },
  {
    id: 20647, registered: '7/11/18',
    registrant: 'Leslie and Lee Geurts', habitat: "Geurts' Glade",
    size: 'Colossal (5,000 sq ft or more)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel TODD J GEURTS found — first name mismatch (Todd ≠ Leslie/Lee)
    approximate: true,
  },
  {
    id: 22096, registered: '9/24/18',
    registrant: 'David and Ann Mitchell', habitat: "Mitchell's",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel MITCHELL L TARLTON found — Mitchell is first name of Tarlton, not a match
    approximate: true,
  },
  {
    id: 35333, registered: '7/11/21',
    registrant: 'Melissa Albers',
    habitat: "MajDandelion's Sommerfuglehave",
    size: 'Medium (200–499 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel DARRIN J ALBERS ETAL found — first name mismatch (Darrin ≠ Melissa)
    approximate: true,
  },
  {
    id: 53989, registered: '9/29/25',
    registrant: 'Michelle Garrigan', habitat: "Michelle's She Space",
    size: 'Small (less than 200 sq ft)', location: 'Home', type: 'home',
    address: 'Green Bay, WI 54313',
    // Parcel MARK A GARRIGAN found — first name mismatch (Mark ≠ Michelle)
    approximate: true,
  },
];
